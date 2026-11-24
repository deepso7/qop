use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hpke::{
    Deserializable, Kem, OpModeR, OpModeS, Serializable,
    aead::ChaCha20Poly1305,
    kdf::HkdfSha256,
    kem::X25519HkdfSha256,
    rand_core::{CryptoRng, RngCore, SeedableRng},
};
use rand_chacha::ChaCha20Rng;

use super::chat::{ChatFrame, MAX_CHAT_PAYLOAD_BYTES};

const VERSION: u8 = 1;
const KEY_BYTES: usize = 32;
const HEADER_BYTES: usize = 1 + 2 * KEY_BYTES;
const SIGNATURE_BYTES: usize = 64;
const TAG_BYTES: usize = 16;
const OVERHEAD_BYTES: usize = HEADER_BYTES + KEY_BYTES + TAG_BYTES + SIGNATURE_BYTES;
pub const MAX_CHAT_ENVELOPE_BYTES: usize = MAX_CHAT_PAYLOAD_BYTES + OVERHEAD_BYTES;

const INFO: &[u8] = b"qop/chat-envelope/1";
const SIGNATURE_DOMAIN: &[u8] = b"qop/chat-envelope/1/sign\0";

type KemSuite = X25519HkdfSha256;
type PublicKey = <KemSuite as Kem>::PublicKey;
type PrivateKey = <KemSuite as Kem>::PrivateKey;
type EncappedKey = <KemSuite as Kem>::EncappedKey;

#[derive(Debug)]
pub struct ChatEnvelopeError;

pub struct ChatCipher(SigningKey);

fn device_key(key: &[u8; KEY_BYTES]) -> Result<VerifyingKey, ChatEnvelopeError> {
    let verified = VerifyingKey::from_bytes(key).map_err(|_| ChatEnvelopeError)?;
    let point = verified.to_edwards();
    if verified.is_weak() || !point.is_torsion_free() || point.compress().as_bytes() != key {
        return Err(ChatEnvelopeError);
    }
    Ok(verified)
}

impl ChatCipher {
    pub fn new(secret: &[u8; KEY_BYTES]) -> Self {
        Self(SigningKey::from_bytes(secret))
    }

    pub fn seal(
        &self,
        frame: &ChatFrame,
        recipient: &[u8; KEY_BYTES],
    ) -> Result<Vec<u8>, ChatEnvelopeError> {
        let mut seed = [0; KEY_BYTES];
        getrandom::fill(&mut seed).map_err(|_| ChatEnvelopeError)?;
        self.seal_with_rng(frame, recipient, &mut ChaCha20Rng::from_seed(seed))
    }

    fn seal_with_rng(
        &self,
        frame: &ChatFrame,
        recipient: &[u8; KEY_BYTES],
        rng: &mut (impl RngCore + CryptoRng),
    ) -> Result<Vec<u8>, ChatEnvelopeError> {
        let plaintext = frame.encode().map_err(|_| ChatEnvelopeError)?;
        let key = device_key(recipient)?;
        let public_key =
            PublicKey::from_bytes(key.to_montgomery().as_bytes()).map_err(|_| ChatEnvelopeError)?;
        let mut envelope = Vec::with_capacity(plaintext.len() + OVERHEAD_BYTES);
        envelope.push(VERSION);
        envelope.extend_from_slice(self.0.verifying_key().as_bytes());
        envelope.extend_from_slice(recipient);
        let (enc, ciphertext) =
            hpke::single_shot_seal::<ChaCha20Poly1305, HkdfSha256, KemSuite, _>(
                &OpModeS::Base,
                &public_key,
                INFO,
                &plaintext,
                &envelope,
                rng,
            )
            .map_err(|_| ChatEnvelopeError)?;
        envelope.extend_from_slice(&enc.to_bytes());
        envelope.extend_from_slice(&ciphertext);
        let signature = self.0.sign(&[SIGNATURE_DOMAIN, &envelope].concat());
        envelope.extend_from_slice(&signature.to_bytes());
        Ok(envelope)
    }

    pub fn open(
        &self,
        envelope: &[u8],
        sender: &[u8; KEY_BYTES],
    ) -> Result<ChatFrame, ChatEnvelopeError> {
        if envelope.len() <= OVERHEAD_BYTES
            || envelope.len() > MAX_CHAT_ENVELOPE_BYTES
            || envelope[0] != VERSION
            || &envelope[1..1 + KEY_BYTES] != sender
            || &envelope[1 + KEY_BYTES..HEADER_BYTES] != self.0.verifying_key().as_bytes()
        {
            return Err(ChatEnvelopeError);
        }
        let (signed, signature) = envelope.split_at(envelope.len() - SIGNATURE_BYTES);
        let signature = Signature::from_slice(signature).map_err(|_| ChatEnvelopeError)?;
        let sender = device_key(sender)?;
        sender
            .verify_strict(&[SIGNATURE_DOMAIN, signed].concat(), &signature)
            .map_err(|_| ChatEnvelopeError)?;

        let (header, body) = signed.split_at(HEADER_BYTES);
        let (enc, ciphertext) = body.split_at(KEY_BYTES);
        let enc = EncappedKey::from_bytes(enc).map_err(|_| ChatEnvelopeError)?;
        let private_key =
            PrivateKey::from_bytes(&self.0.to_scalar_bytes()).map_err(|_| ChatEnvelopeError)?;
        let plaintext = hpke::single_shot_open::<ChaCha20Poly1305, HkdfSha256, KemSuite>(
            &OpModeR::Base,
            &private_key,
            &enc,
            INFO,
            ciphertext,
            header,
        )
        .map_err(|_| ChatEnvelopeError)?;
        ChatFrame::decode(&plaintext).map_err(|_| ChatEnvelopeError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::hex;
    use serde_json::Value;

    fn typescript_vector() -> (Vec<u8>, ChatFrame) {
        let vector: Value =
            serde_json::from_str(include_str!("../../tests/vectors/chat-envelope.json")).unwrap();
        let bytes = hex::decode(vector["envelope"].as_str().unwrap()).unwrap();
        let frame = ChatFrame::from_json(&vector["frame"], false).unwrap();
        (bytes, frame)
    }

    #[test]
    fn matches_the_typescript_envelope_in_both_directions() {
        let (bytes, expected) = typescript_vector();
        let alice = ChatCipher::new(&[0; 32]);
        let bob = ChatCipher::new(&[1; 32]);

        assert_eq!(
            bob.open(&bytes, alice.0.verifying_key().as_bytes())
                .unwrap(),
            expected
        );
        assert_eq!(
            alice
                .seal_with_rng(
                    &expected,
                    bob.0.verifying_key().as_bytes(),
                    &mut ChaCha20Rng::from_seed([0; 32]),
                )
                .unwrap(),
            bytes
        );
    }

    #[test]
    fn rejects_the_wrong_sender_or_recipient() {
        let (bytes, _) = typescript_vector();
        let alice = ChatCipher::new(&[0; 32]);
        let bob = ChatCipher::new(&[1; 32]);
        let other = ChatCipher::new(&[2; 32]);

        assert!(
            bob.open(&bytes, other.0.verifying_key().as_bytes())
                .is_err()
        );
        assert!(
            other
                .open(&bytes, alice.0.verifying_key().as_bytes())
                .is_err()
        );
    }

    #[test]
    fn rejects_altered_envelope_fields() {
        let (bytes, _) = typescript_vector();
        let alice = ChatCipher::new(&[0; 32]);
        let bob = ChatCipher::new(&[1; 32]);
        let sender = alice.0.verifying_key();

        for (field, offset) in [
            ("version", 0),
            ("sender", 1),
            ("recipient", 1 + KEY_BYTES),
            ("encapsulated key", HEADER_BYTES),
            ("ciphertext", HEADER_BYTES + KEY_BYTES),
            ("signature", bytes.len() - SIGNATURE_BYTES),
        ] {
            let mut altered = bytes.clone();
            altered[offset] ^= 1;
            assert!(bob.open(&altered, sender.as_bytes()).is_err(), "{field}");
        }
    }

    #[test]
    fn rejects_plaintext_and_invalid_lengths() {
        let (mut bytes, frame) = typescript_vector();
        let alice = ChatCipher::new(&[0; 32]);
        let bob = ChatCipher::new(&[1; 32]);
        let sender = alice.0.verifying_key();
        let mut plaintext_frame = frame;
        plaintext_frame.text = "valid chat without an envelope ".repeat(8);
        let plaintext = plaintext_frame.encode().unwrap();
        assert!(plaintext.len() > OVERHEAD_BYTES);

        assert!(bob.open(&plaintext, sender.as_bytes()).is_err());
        for len in [0, OVERHEAD_BYTES, bytes.len() - 1] {
            assert!(bob.open(&bytes[..len], sender.as_bytes()).is_err(), "{len}");
        }
        bytes.resize(MAX_CHAT_ENVELOPE_BYTES + 1, 0);
        assert!(bob.open(&bytes, sender.as_bytes()).is_err());
    }
}
