//! Stream framing shared by `/qop/pair/1`, `/qop/chat/1` and `/qop/sync/1`.
//!
//! There is no length prefix: a sender writes one JSON message, then
//! half-closes its write side. The receiver collects chunks until EOF, so the
//! message is complete only once the peer has half-closed. Each protocol caps
//! the total (`pairing-io.ts`, `sync-io.ts`, `readUntilEof` in `chat.ts`), and
//! the cap is enforced as chunks arrive, not only at EOF.
//!
//! A request/response exchange is: write request, half-close, read the
//! response until EOF. The responder reads to EOF before it answers.

/// The peer sent more than the protocol's byte cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Oversized;

/// Collects one message from chunks read off a stream.
#[derive(Debug)]
pub struct FrameReader {
    buf: Vec<u8>,
    max_bytes: usize,
}

impl FrameReader {
    /// A reader capped at `max_bytes`, e.g. `PAIRING_FRAME_MAX_BYTES`.
    pub fn new(max_bytes: usize) -> Self {
        Self {
            buf: Vec::new(),
            max_bytes,
        }
    }

    /// Append one chunk. After `Err`, reset the stream: the message is lost.
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), Oversized> {
        if self.buf.len() + chunk.len() > self.max_bytes {
            return Err(Oversized);
        }

        self.buf.extend_from_slice(chunk);

        Ok(())
    }

    /// The peer half-closed (EOF): everything received is the message. It
    /// may be empty; the protocol decoder rejects that.
    pub fn finish(self) -> Vec<u8> {
        self.buf
    }
}
