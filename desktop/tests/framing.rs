//! Stream framing for pairing, chat and sync: a message is everything a peer
//! writes before half-closing, capped per protocol. Byte vectors cannot cover
//! chunking, EOF and half-close, so these tests drive `FrameReader` directly.

use std::collections::VecDeque;

use alloy_primitives::B256;
use qop_desktop::wire::*;

/// One direction of a stream: chunks the writer sent, then maybe EOF.
#[derive(Default)]
struct Pipe {
    chunks: VecDeque<Vec<u8>>,
    half_closed: bool,
}

impl Pipe {
    /// Write `bytes` in chunks of `chunk_size`, as a transport may split them.
    fn write(&mut self, bytes: &[u8], chunk_size: usize) {
        assert!(!self.half_closed, "write after half-close");
        self.chunks
            .extend(bytes.chunks(chunk_size).map(<[u8]>::to_vec));
    }

    fn close_write(&mut self) {
        self.half_closed = true;
    }

    /// Read one message: every chunk, then EOF. An oversized message fails
    /// on the chunk that crosses the cap, before EOF.
    fn read_message(&mut self, max_bytes: usize) -> Result<Vec<u8>, Oversized> {
        let mut reader = FrameReader::new(max_bytes);

        while let Some(chunk) = self.chunks.pop_front() {
            reader.push(&chunk)?;
        }

        assert!(self.half_closed, "a real reader would wait for EOF here");

        Ok(reader.finish())
    }
}

fn hello() -> PairingFrame {
    PairingFrame::Hello {
        challenge: B256::repeat_byte(0xc3),
        secret: B256::repeat_byte(0xb2),
        session_id: B256::repeat_byte(0xa1),
    }
}

#[test]
fn fragmented_reads_reassemble_the_message() {
    let bytes = hello().encode().unwrap();

    for chunk_size in [1, 7, 64, bytes.len()] {
        let mut pipe = Pipe::default();
        pipe.write(&bytes, chunk_size);
        pipe.close_write();

        let message = pipe.read_message(PAIRING_FRAME_MAX_BYTES).unwrap();

        assert_eq!(
            PairingFrame::decode(&message),
            Ok(hello()),
            "chunk size {chunk_size}"
        );
    }
}

#[test]
fn message_is_complete_only_at_eof() {
    let bytes = SyncRequest::Catchup { after: 7 }.encode().unwrap();
    let (head, tail) = bytes.split_at(bytes.len() / 2);
    let mut reader = FrameReader::new(MAX_SYNC_PAYLOAD_BYTES);

    reader.push(head).unwrap();
    // Without a length prefix, what arrived so far is not a message.
    assert_eq!(SyncRequest::decode(head), Err(SyncCodecError::Frame));

    reader.push(tail).unwrap();
    let message = reader.finish();

    assert_eq!(
        SyncRequest::decode(&message),
        Ok(SyncRequest::Catchup { after: 7 })
    );
}

#[test]
fn eof_without_data_is_an_empty_invalid_message() {
    let mut pipe = Pipe::default();
    pipe.close_write();
    let message = pipe.read_message(MAX_CHAT_PAYLOAD_BYTES).unwrap();

    assert!(message.is_empty());
    assert_eq!(ChatFrame::decode(&message), Err(ChatError::Invalid));
    assert_eq!(PairingFrame::decode(&message), Err(PairingError::Frame));
}

#[test]
fn cap_applies_while_reading_not_only_at_eof() {
    let mut reader = FrameReader::new(8);

    assert_eq!(reader.push(b"1234"), Ok(()));
    assert_eq!(reader.push(b"5678"), Ok(()), "exactly at the cap");
    assert_eq!(
        reader.push(b"9"),
        Err(Oversized),
        "the chunk crossing the cap fails before EOF"
    );

    let mut pipe = Pipe::default();
    pipe.write(&vec![b' '; PAIRING_FRAME_MAX_BYTES + 1], 1000);

    assert_eq!(
        pipe.read_message(PAIRING_FRAME_MAX_BYTES),
        Err(Oversized),
        "no half-close needed"
    );
}

#[test]
fn request_response_over_two_half_closes() {
    // A duplex stream is two pipes; half-closing one direction leaves the
    // other open, so the phone still reads the reply after sending.
    let (mut to_desktop, mut to_phone) = (Pipe::default(), Pipe::default());

    to_desktop.write(&hello().encode().unwrap(), 5);
    to_desktop.close_write();

    let request = to_desktop.read_message(PAIRING_FRAME_MAX_BYTES).unwrap();
    let PairingFrame::Hello {
        challenge,
        session_id,
        ..
    } = PairingFrame::decode(&request).unwrap()
    else {
        panic!("expected hello");
    };
    let reply = PairingFrame::ApprovalSaved {
        digest: challenge,
        session_id,
    };

    to_phone.write(&reply.encode().unwrap(), 3);
    to_phone.close_write();

    let response = to_phone.read_message(PAIRING_FRAME_MAX_BYTES).unwrap();

    assert_eq!(PairingFrame::decode(&response), Ok(reply));
}
