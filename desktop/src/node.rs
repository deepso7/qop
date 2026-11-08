//! The minip2p node: one dedicated thread owns the caller-driven std `Endpoint`.
//!
//! The thread blocks in `Endpoint::wait`; commands from the engine arrive over a channel and
//! interrupt that wait through the endpoint's `WaitHandle`. Everything async-facing is a
//! [`NodeHandle`] (cloneable) or a [`Stream`]; nothing outside this file touches the endpoint.
//!
//! Streams follow the protocol framing of `wire::framing`: write one message, half-close, read
//! to EOF. [`Stream::write`] resolves once the endpoint accepted every byte (not once the peer
//! received them), and [`Stream::close_write`] sends the FIN behind any write still held.

use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::sync::mpsc as std_mpsc;
use std::thread::JoinHandle;

use minip2p::{
    ConnectId, ConnectOutcome, ConnectionId, Ed25519Keypair, Endpoint, EndpointEvent,
    EndpointWaitOutcome, Multiaddr, NatEvent, PeerAddr, PeerId, Protocol, StreamId, StreamWriter,
    WaitDeadline, WaitHandle, WriteProgress,
};
use tokio::sync::{mpsc, oneshot};

use crate::wire::{FrameReader, Oversized};

/// Most unsent bytes the node holds across all streams (pairing frames are 16 KiB).
const WRITE_BUDGET: usize = 4 * 1024 * 1024;

/// What to bind and announce. Mirrors the CLI's `Minip2p.create` options.
#[derive(Clone, Debug)]
pub struct NodeConfig {
    /// The device's Ed25519 secret key; the node's peer ID is derived from it.
    pub secret: [u8; 32],
    pub agent_version: String,
    /// Application protocols accepted inbound (and dialable outbound).
    pub protocols: Vec<String>,
    /// Relay peer addresses; a reservation is held on them while not known to be public.
    pub relays: Vec<String>,
    /// Listen multiaddrs; empty means dual-stack QUIC on ephemeral ports.
    pub listen: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeError {
    /// The configuration was rejected before binding (bad relay or listen address).
    Config(String),
    /// Sockets or capabilities failed to start.
    Bind(String),
    /// A connection attempt settled without a connection.
    Connect(String),
    /// The stream failed, was reset, or its connection ended.
    Stream(String),
    /// The peer sent more than the protocol allows; the stream was reset.
    Oversized,
    /// The node thread has stopped.
    Stopped,
}

impl fmt::Display for NodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(detail) => write!(f, "node config: {detail}"),
            Self::Bind(detail) => write!(f, "node bind: {detail}"),
            Self::Connect(detail) => write!(f, "connect: {detail}"),
            Self::Stream(detail) => write!(f, "stream: {detail}"),
            Self::Oversized => f.write_str("stream: peer sent too much"),
            Self::Stopped => f.write_str("node stopped"),
        }
    }
}

/// What the node reports to its owner, in order.
#[derive(Debug)]
pub enum NodeEvent {
    /// A relay granted a reservation; `circuit` is this node's address through it.
    RelayReserved { circuit: String },
    /// The reservation was lost; the endpoint keeps trying to reserve again.
    RelayLost,
    /// A peer opened a stream for one of the configured protocols.
    InboundStream(Stream),
}

/// The running node. Dropping it (or [`Node::shutdown`]) closes the endpoint and joins the thread.
pub struct Node {
    handle: NodeHandle,
    peer_id: PeerId,
    listen: Vec<String>,
    thread: Option<JoinHandle<()>>,
}

/// A cloneable way to drive the node from async code.
#[derive(Clone)]
pub struct NodeHandle {
    commands: std_mpsc::Sender<Command>,
    wake: WaitHandle,
}

type StreamKey = (ConnectionId, StreamId);
type Reply<T> = oneshot::Sender<Result<T, NodeError>>;

enum Command {
    Connect {
        addrs: Vec<String>,
        reply: Reply<PeerId>,
    },
    Open {
        peer: PeerId,
        protocol: String,
        reply: Reply<Stream>,
    },
    Write {
        key: StreamKey,
        data: Vec<u8>,
        reply: Reply<()>,
    },
    CloseWrite {
        key: StreamKey,
        reply: Reply<()>,
    },
    Reset {
        key: StreamKey,
    },
    Shutdown,
}

/// What a stream's reader sees, in order.
#[derive(Debug)]
enum Chunk {
    Data(Vec<u8>),
    /// The peer half-closed its write side.
    Eof,
    /// The stream or its connection ended.
    Gone(String),
}

impl Node {
    /// Binds the endpoint on the calling thread (so bind errors return here), then hands it to
    /// the node thread. Events arrive on the returned receiver until the node stops.
    pub fn start(
        config: NodeConfig,
    ) -> Result<(Node, mpsc::UnboundedReceiver<NodeEvent>), NodeError> {
        let relays = config
            .relays
            .iter()
            .map(|addr| {
                PeerAddr::from_str(addr)
                    .map_err(|e| NodeError::Config(format!("relay {addr}: {e}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut builder = Endpoint::builder()
            .identity(Ed25519Keypair::from_secret_key_bytes(config.secret))
            .agent_version(config.agent_version);
        for protocol in &config.protocols {
            builder = builder.protocol(protocol.clone());
        }
        for relay in &relays {
            builder = builder.relay(relay.clone());
        }
        builder = if config.listen.is_empty() {
            builder
                .listen_default()
                .map_err(|e| NodeError::Config(e.to_string()))?
        } else {
            config.listen.iter().try_fold(builder, |b, addr| {
                b.listen_on(addr)
                    .map_err(|e| NodeError::Config(e.to_string()))
            })?
        };
        let mut endpoint = builder.bind().map_err(|e| NodeError::Bind(e.to_string()))?;
        let listen = endpoint
            .listen_all()
            .map_err(|e| NodeError::Bind(e.to_string()))?
            .iter()
            .map(ToString::to_string)
            .collect();
        let peer_id = endpoint.peer_id().clone();
        let (commands, inbox) = std_mpsc::channel();
        let handle = NodeHandle {
            commands,
            wake: endpoint.wait_handle(),
        };
        let (events, receiver) = mpsc::unbounded_channel();
        let driver = Driver::new(handle.clone(), events, relays);
        let thread = std::thread::Builder::new()
            .name("qop-node".into())
            .spawn(move || driver.run(endpoint, inbox))
            .map_err(|e| NodeError::Bind(e.to_string()))?;
        Ok((
            Node {
                handle,
                peer_id,
                listen,
                thread: Some(thread),
            },
            receiver,
        ))
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }

    /// The bound listen addresses as complete peer addresses (wildcards not yet expanded).
    pub fn listen_addrs(&self) -> &[String] {
        &self.listen
    }

    pub fn handle(&self) -> NodeHandle {
        self.handle.clone()
    }

    /// Closes the endpoint (draining briefly) and waits for the thread to exit.
    pub fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        if let Some(thread) = self.thread.take() {
            self.handle.send(Command::Shutdown);
            let _ = thread.join();
        }
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        self.stop();
    }
}

impl NodeHandle {
    fn send(&self, command: Command) -> bool {
        let sent = self.commands.send(command).is_ok();
        self.wake.interrupt();
        sent
    }

    async fn request<T>(&self, command: impl FnOnce(Reply<T>) -> Command) -> Result<T, NodeError> {
        let (reply, response) = oneshot::channel();
        if !self.send(command(reply)) {
            return Err(NodeError::Stopped);
        }
        response.await.unwrap_or(Err(NodeError::Stopped))
    }

    /// Connects to a peer at one or more complete addresses of that peer; resolves once a
    /// connection is established (relay legs and direct upgrades included).
    pub async fn connect(&self, addrs: Vec<String>) -> Result<PeerId, NodeError> {
        self.request(|reply| Command::Connect { addrs, reply })
            .await
    }

    /// Opens a stream to a connected peer and negotiates `protocol`.
    pub async fn open_stream(&self, peer: &PeerId, protocol: &str) -> Result<Stream, NodeError> {
        let (peer, protocol) = (peer.clone(), protocol.to_owned());
        self.request(|reply| Command::Open {
            peer,
            protocol,
            reply,
        })
        .await
    }
}

/// One application stream. Dropping it before both sides finished resets it.
pub struct Stream {
    pub peer: PeerId,
    pub protocol: String,
    key: StreamKey,
    node: NodeHandle,
    incoming: mpsc::UnboundedReceiver<Chunk>,
    read_done: bool,
    write_done: bool,
}

impl fmt::Debug for Stream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Stream")
            .field("peer", &self.peer.to_base58())
            .field("protocol", &self.protocol)
            .finish()
    }
}

impl Stream {
    /// Queues `data`; resolves once the endpoint accepted every byte.
    pub async fn write(&self, data: Vec<u8>) -> Result<(), NodeError> {
        let key = self.key;
        self.node
            .request(|reply| Command::Write { key, data, reply })
            .await
    }

    /// Half-closes the write side; the FIN follows every byte written before.
    pub async fn close_write(&mut self) -> Result<(), NodeError> {
        let key = self.key;
        self.node
            .request(|reply| Command::CloseWrite { key, reply })
            .await?;
        self.write_done = true;
        Ok(())
    }

    /// Writes one message and half-closes: the sending half of every QOP exchange.
    pub async fn send_message(&mut self, data: Vec<u8>) -> Result<(), NodeError> {
        self.write(data).await?;
        self.close_write().await
    }

    /// Reads until the peer half-closes. Over `max_bytes`, the stream is reset.
    pub async fn read_to_end(&mut self, max_bytes: usize) -> Result<Vec<u8>, NodeError> {
        let mut reader = FrameReader::new(max_bytes);
        loop {
            match self.incoming.recv().await {
                Some(Chunk::Data(data)) => {
                    if let Err(Oversized) = reader.push(&data) {
                        self.reset();
                        return Err(NodeError::Oversized);
                    }
                }
                Some(Chunk::Eof) => {
                    self.read_done = true;
                    return Ok(reader.finish());
                }
                Some(Chunk::Gone(reason)) => return Err(NodeError::Stream(reason)),
                None => return Err(NodeError::Stopped),
            }
        }
    }

    /// Abandons the stream in both directions.
    pub fn reset(&mut self) {
        self.read_done = true;
        self.write_done = true;
        self.node.send(Command::Reset { key: self.key });
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        if !(self.read_done && self.write_done) {
            self.reset();
        }
    }
}

/// State owned by the node thread.
struct Driver {
    handle: NodeHandle,
    events: mpsc::UnboundedSender<NodeEvent>,
    relays: Vec<PeerAddr>,
    writer: StreamWriter,
    /// Readers of live streams.
    streams: HashMap<StreamKey, mpsc::UnboundedSender<Chunk>>,
    /// Locally opened streams awaiting negotiation, with their reader halves.
    opens: HashMap<
        StreamKey,
        (
            Reply<Stream>,
            String,
            PeerId,
            mpsc::UnboundedReceiver<Chunk>,
        ),
    >,
    writes: HashMap<StreamKey, Reply<()>>,
    connects: HashMap<ConnectId, Reply<PeerId>>,
}

impl Driver {
    fn new(
        handle: NodeHandle,
        events: mpsc::UnboundedSender<NodeEvent>,
        relays: Vec<PeerAddr>,
    ) -> Driver {
        Driver {
            handle,
            events,
            relays,
            writer: StreamWriter::new(WRITE_BUDGET),
            streams: HashMap::new(),
            opens: HashMap::new(),
            writes: HashMap::new(),
            connects: HashMap::new(),
        }
    }

    fn run(mut self, mut endpoint: Endpoint, inbox: std_mpsc::Receiver<Command>) {
        'run: loop {
            loop {
                match inbox.try_recv() {
                    Ok(Command::Shutdown) | Err(std_mpsc::TryRecvError::Disconnected) => break 'run,
                    Ok(command) => self.command(&mut endpoint, command),
                    Err(std_mpsc::TryRecvError::Empty) => break,
                }
            }
            match endpoint.wait(WaitDeadline::NEVER) {
                Ok(EndpointWaitOutcome::Event(event)) => self.event(&mut endpoint, event),
                Ok(_) => {}
                Err(error) => {
                    eprintln!("qop: node: {error}");
                    // A failing readiness poll must not spin the thread.
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        }
        // Pending replies drop here, so their callers see `Stopped`.
        let report = endpoint.close();
        if !report.unfinished.is_empty() {
            eprintln!(
                "qop: node closed with {} connections unfinished",
                report.unfinished.len()
            );
        }
    }

    fn command(&mut self, endpoint: &mut Endpoint, command: Command) {
        match command {
            Command::Connect { addrs, reply } => {
                let target = addrs
                    .iter()
                    .map(|addr| {
                        PeerAddr::from_str(addr)
                            .map_err(|e| NodeError::Connect(format!("{addr}: {e}")))
                    })
                    .collect::<Result<Vec<_>, _>>();
                match target.map(|t| {
                    endpoint
                        .connect(t)
                        .map_err(|e| NodeError::Connect(e.to_string()))
                }) {
                    Ok(Ok(id)) => {
                        self.connects.insert(id, reply);
                    }
                    Ok(Err(error)) | Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Command::Open {
                peer,
                protocol,
                reply,
            } => match endpoint.open_stream(&peer, &protocol) {
                Ok(key) => {
                    let (tx, rx) = mpsc::unbounded_channel();
                    self.streams.insert(key, tx);
                    self.opens.insert(key, (reply, protocol, peer, rx));
                }
                Err(error) => {
                    let _ = reply.send(Err(NodeError::Stream(error.to_string())));
                }
            },
            Command::Write { key, data, reply } => {
                match self.writer.write(endpoint, key.0, key.1, data) {
                    Ok(WriteProgress::Accepted) => {
                        let _ = reply.send(Ok(()));
                    }
                    Ok(WriteProgress::Pending) => {
                        self.writes.insert(key, reply);
                    }
                    Err(error) => {
                        let _ = reply.send(Err(NodeError::Stream(error.to_string())));
                    }
                }
            }
            Command::CloseWrite { key, reply } => {
                let result = self.writer.close_write(endpoint, key.0, key.1);
                let _ = reply.send(result.map_err(|e| NodeError::Stream(e.to_string())));
            }
            Command::Reset { key } => {
                self.streams.remove(&key);
                self.writer.forget(key.0, key.1);
                if let Some(reply) = self.writes.remove(&key) {
                    let _ = reply.send(Err(NodeError::Stream("reset".into())));
                }
                // Already gone is fine: there is nothing left to reset.
                let _ = endpoint.abandon_stream(key.0, key.1);
            }
            Command::Shutdown => {}
        }
    }

    fn event(&mut self, endpoint: &mut Endpoint, event: EndpointEvent) {
        if let Some(done) = self.writer.observe(endpoint, &event)
            && let Some(reply) = self.writes.remove(&(done.conn_id, done.stream_id))
        {
            let _ = reply.send(Ok(()));
        }
        // A held write the writer dropped (stream or connection ended) will never complete.
        let writer = &self.writer;
        self.writes.retain(|key, _| writer.is_pending(key.0, key.1));
        match event {
            EndpointEvent::ConnectSettled {
                connect_id,
                peer_id,
                outcome,
            } => {
                if let Some(reply) = self.connects.remove(&connect_id) {
                    let result = match outcome {
                        ConnectOutcome::Connected { .. } => Ok(peer_id),
                        other => Err(NodeError::Connect(format!("{other:?}"))),
                    };
                    let _ = reply.send(result);
                }
            }
            EndpointEvent::StreamReady {
                peer_id,
                conn_id,
                stream_id,
                protocol_id,
                initiated_locally,
            } => {
                let key = (conn_id, stream_id);
                if initiated_locally {
                    if let Some((reply, protocol, peer, incoming)) = self.opens.remove(&key) {
                        let stream = self.stream(key, peer, protocol, incoming);
                        let _ = reply.send(Ok(stream));
                    }
                } else {
                    let (tx, rx) = mpsc::unbounded_channel();
                    self.streams.insert(key, tx);
                    let stream = self.stream(key, peer_id, protocol_id, rx);
                    let _ = self.events.send(NodeEvent::InboundStream(stream));
                }
            }
            EndpointEvent::StreamData {
                conn_id,
                stream_id,
                data,
                ..
            } => {
                self.chunk((conn_id, stream_id), Chunk::Data(data.to_vec()));
            }
            EndpointEvent::StreamRemoteWriteClosed {
                conn_id, stream_id, ..
            } => {
                self.chunk((conn_id, stream_id), Chunk::Eof);
            }
            EndpointEvent::StreamClosed {
                conn_id, stream_id, ..
            } => {
                self.end((conn_id, stream_id), "closed");
            }
            EndpointEvent::Error(error) => {
                if let (Some(conn), Some(stream)) = (error.conn_id, error.stream_id) {
                    self.end((conn, stream), &error.detail);
                }
            }
            EndpointEvent::ConnectionClosed { conn_id, .. } => {
                self.end_connection(conn_id, "connection closed")
            }
            EndpointEvent::ConnectionReplaced { old, .. } => {
                self.end_connection(old, "connection replaced")
            }
            EndpointEvent::Nat(NatEvent::RelayReserved { relay, .. }) => {
                if let Some(circuit) = self.circuit_address(&relay, endpoint.peer_id()) {
                    let _ = self.events.send(NodeEvent::RelayReserved { circuit });
                }
            }
            EndpointEvent::Nat(NatEvent::RelayReservationLost { .. }) => {
                let _ = self.events.send(NodeEvent::RelayLost);
            }
            _ => {}
        }
    }

    fn stream(
        &self,
        key: StreamKey,
        peer: PeerId,
        protocol: String,
        incoming: mpsc::UnboundedReceiver<Chunk>,
    ) -> Stream {
        Stream {
            peer,
            protocol,
            key,
            node: self.handle.clone(),
            incoming,
            read_done: false,
            write_done: false,
        }
    }

    fn chunk(&mut self, key: StreamKey, chunk: Chunk) {
        if let Some(reader) = self.streams.get(&key) {
            // A dropped reader already reset the stream; late data has nowhere to go.
            let _ = reader.send(chunk);
        }
    }

    /// The stream ended: its reader learns why, and an open still negotiating fails.
    fn end(&mut self, key: StreamKey, reason: &str) {
        if let Some(reader) = self.streams.remove(&key) {
            let _ = reader.send(Chunk::Gone(reason.to_owned()));
        }
        if let Some((reply, ..)) = self.opens.remove(&key) {
            let _ = reply.send(Err(NodeError::Stream(reason.to_owned())));
        }
    }

    fn end_connection(&mut self, conn: ConnectionId, reason: &str) {
        let keys: Vec<_> = self
            .streams
            .keys()
            .chain(self.opens.keys())
            .filter(|key| key.0 == conn)
            .copied()
            .collect();
        for key in keys {
            self.end(key, reason);
        }
    }

    /// `<relay transport>/p2p/<relay>/p2p-circuit/p2p/<self>` for a configured relay.
    fn circuit_address(&self, relay: &PeerId, own: &PeerId) -> Option<String> {
        let relay = self.relays.iter().find(|addr| addr.peer_id() == relay)?;
        let mut protocols = relay.transport().protocols().to_vec();
        protocols.extend([
            Protocol::P2p(relay.peer_id().clone()),
            Protocol::P2pCircuit,
            Protocol::P2p(own.clone()),
        ]);
        Some(Multiaddr::from_protocols(protocols).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ECHO: &str = "/qop-test/echo/1";

    fn node(seed: u8) -> (Node, mpsc::UnboundedReceiver<NodeEvent>) {
        Node::start(NodeConfig {
            secret: [seed; 32],
            agent_version: "qop-desktop-test".into(),
            protocols: vec![ECHO.into()],
            relays: vec![],
            listen: vec!["/ip4/127.0.0.1/udp/0/quic-v1".into()],
        })
        .expect("node binds on loopback")
    }

    /// A request/response exchange over loopback QUIC: a payload larger than one stream window
    /// (so the write is held and completes later), half-close on both sides, then a clean
    /// shutdown of both threads.
    #[tokio::test]
    async fn exchanges_one_message_each_way_and_shuts_down() {
        let (server, mut server_events) = node(1);
        let (client, _client_events) = node(2);
        let request: Vec<u8> = (0..1_500_000u32).map(|i| i as u8).collect();

        let serve = tokio::spawn(async move {
            let Some(NodeEvent::InboundStream(mut stream)) = server_events.recv().await else {
                panic!("expected an inbound stream");
            };
            assert_eq!(stream.protocol, ECHO);
            let body = stream.read_to_end(2_000_000).await.expect("request");
            stream
                .send_message(format!("got {}", body.len()).into_bytes())
                .await
                .expect("reply");
            body
        });

        let peer = client
            .handle()
            .connect(server.listen_addrs().to_vec())
            .await
            .expect("connect");
        assert_eq!(&peer, server.peer_id());
        let mut stream = client
            .handle()
            .open_stream(&peer, ECHO)
            .await
            .expect("open");
        stream
            .send_message(request.clone())
            .await
            .expect("write completes");
        let reply = stream.read_to_end(1024).await.expect("reply");

        assert_eq!(reply, b"got 1500000");
        assert_eq!(serve.await.expect("server task"), request);
        drop(stream);
        client.shutdown();
        server.shutdown();
    }

    #[tokio::test]
    async fn resets_a_stream_whose_peer_sends_too_much() {
        let (server, mut server_events) = node(3);
        let (client, _client_events) = node(4);

        let serve = tokio::spawn(async move {
            let Some(NodeEvent::InboundStream(mut stream)) = server_events.recv().await else {
                panic!("expected an inbound stream");
            };
            stream.read_to_end(16).await
        });

        let peer = client
            .handle()
            .connect(server.listen_addrs().to_vec())
            .await
            .expect("connect");
        let mut stream = client
            .handle()
            .open_stream(&peer, ECHO)
            .await
            .expect("open");
        // The reset can beat our FIN, so closing the write side may already fail.
        let _ = stream.send_message(vec![7; 64]).await;

        assert_eq!(serve.await.expect("server task"), Err(NodeError::Oversized));
        // The reset reaches the client as the end of the stream, not as a reply.
        assert!(stream.read_to_end(1024).await.is_err());
    }

    #[tokio::test]
    async fn fails_pending_calls_once_shut_down() {
        let (node, _events) = node(5);
        let handle = node.handle();
        node.shutdown();
        assert_eq!(handle.connect(vec!["/ip4/127.0.0.1/udp/9/quic-v1/p2p/12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN".into()]).await, Err(NodeError::Stopped));
    }
}
