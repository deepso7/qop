//! JSON helpers that reproduce how the TS codecs read and write JSON.
//!
//! TS decodes with `JSON.parse` and then an Effect schema. Decoding here goes
//! through `serde_json::Value` with hand-written field readers instead of
//! serde derive, because derive differs from the TS behavior in ways that
//! matter on the wire: it accepts arrays as structs, rejects duplicate keys
//! (JS keeps the last one), and cannot share one struct between strict and
//! lenient decoders. Numbers are read as JS numbers (`f64`), so `1.0` and
//! `1e3` are integers, as in JS.
//!
//! Encoding builds `Value` objects. Every TS struct declares its fields in
//! byte order, so inserting keys sorted reproduces `JSON.stringify` output.

use alloy_primitives::{Address, B256, U256, hex};
use serde_json::{Map, Value};

/// Input that failed schema validation; each codec maps it to its own error.
#[derive(Debug)]
pub(crate) struct Invalid;

pub(crate) type Parsed<T> = Result<T, Invalid>;

const BOM: &[u8] = b"\xef\xbb\xbf";

/// `JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))`:
/// a leading BOM is dropped and malformed UTF-8 is rejected.
pub(crate) fn parse(bytes: &[u8]) -> Parsed<Value> {
    let bytes = bytes.strip_prefix(BOM).unwrap_or(bytes);
    let text = std::str::from_utf8(bytes).map_err(|_| Invalid)?;

    serde_json::from_str(text).map_err(|_| Invalid)
}

/// `Response.json()`: like [`parse`], but malformed UTF-8 becomes U+FFFD.
pub(crate) fn parse_lossy(bytes: &[u8]) -> Parsed<Value> {
    let bytes = bytes.strip_prefix(BOM).unwrap_or(bytes);

    serde_json::from_str(&String::from_utf8_lossy(bytes)).map_err(|_| Invalid)
}

/// Serialize like `JSON.stringify` (no whitespace).
pub(crate) fn to_bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("a serde_json::Value always serializes")
}

/// Build a JSON object. Pass fields in byte order of their names.
pub(crate) fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect::<Map<_, _>>(),
    )
}

pub(crate) fn hex32_value(value: &B256) -> Value {
    Value::String(hex::encode_prefixed(value))
}

pub(crate) fn address_value(value: &Address) -> Value {
    Value::String(hex::encode_prefixed(value))
}

pub(crate) fn decimal_value(value: &U256) -> Value {
    Value::String(value.to_string())
}

/// Reads the fields of one JSON object. Strict decoders (TS
/// `onExcessProperty: "error"`) call [`Obj::finish`] with `strict = true`
/// to reject keys that were never read.
pub(crate) struct Obj<'a> {
    map: &'a Map<String, Value>,
    read: usize,
}

impl<'a> Obj<'a> {
    pub(crate) fn new(value: &'a Value) -> Parsed<Self> {
        match value {
            Value::Object(map) => Ok(Self { map, read: 0 }),
            _ => Err(Invalid),
        }
    }

    /// A required field. Read each key at most once.
    pub(crate) fn field(&mut self, key: &str) -> Parsed<&'a Value> {
        let value = self.map.get(key).ok_or(Invalid)?;
        self.read += 1;

        Ok(value)
    }

    pub(crate) fn finish(self, strict: bool) -> Parsed<()> {
        if strict && self.read != self.map.len() {
            return Err(Invalid);
        }

        Ok(())
    }
}

pub(crate) fn str(value: &Value) -> Parsed<&str> {
    value.as_str().ok_or(Invalid)
}

pub(crate) fn array(value: &Value) -> Parsed<&[Value]> {
    value.as_array().map(Vec::as_slice).ok_or(Invalid)
}

/// `Schema.NullOr(...)`: the key must be present; `null` reads as `None`.
pub(crate) fn null_or<'a, T>(
    value: &'a Value,
    read: impl FnOnce(&'a Value) -> Parsed<T>,
) -> Parsed<Option<T>> {
    if value.is_null() {
        Ok(None)
    } else {
        read(value).map(Some)
    }
}

/// `Schema.Literal(1)`: any JSON number equal to 1 (`1.0` included).
pub(crate) fn version_1(value: &Value) -> Parsed<()> {
    if value.as_f64() == Some(1.0) {
        Ok(())
    } else {
        Err(Invalid)
    }
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `Schema.Int` (a JS safe integer) within `min..=max`.
pub(crate) fn int(value: &Value, min: u64, max: u64) -> Parsed<u64> {
    let number = value.as_f64().ok_or(Invalid)?;

    if number.fract() != 0.0
        || number.abs() > MAX_SAFE_INTEGER
        || number < min as f64
        || number > max as f64
    {
        return Err(Invalid);
    }

    // Safe integers in `min..=max` convert exactly (`-0` becomes 0).
    Ok(number as u64)
}

/// String length in UTF-16 code units, as JS `String.length` counts it.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// A string of `min..=max` UTF-16 code units.
pub(crate) fn text(value: &Value, min: usize, max: usize) -> Parsed<&str> {
    let text = str(value)?;

    if (min..=max).contains(&utf16_len(text)) {
        Ok(text)
    } else {
        Err(Invalid)
    }
}

fn is_lower_hex(text: &str) -> bool {
    text.bytes()
        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// `^0x[0-9a-f]{digits}$`, decoded to bytes.
pub(crate) fn lower_hex(text: &str, digits: usize) -> Parsed<Vec<u8>> {
    let body = text.strip_prefix("0x").ok_or(Invalid)?;

    if body.len() != digits || !is_lower_hex(body) {
        return Err(Invalid);
    }

    hex::decode(body).map_err(|_| Invalid)
}

/// TS `Hex32` in canonical form: lowercase `0x` + 64 hex digits.
pub(crate) fn hex32(value: &Value) -> Parsed<B256> {
    Ok(B256::from_slice(&lower_hex(str(value)?, 64)?))
}

/// TS `DeviceKey` / `RegistrationNonce`: a [`hex32`] that is not all zeros.
pub(crate) fn non_zero_hex32(value: &Value) -> Parsed<B256> {
    let bytes = hex32(value)?;

    if bytes.is_zero() {
        Err(Invalid)
    } else {
        Ok(bytes)
    }
}

/// TS `EthereumAddress`: lowercase `0x` + 40 hex digits.
pub(crate) fn address(value: &Value) -> Parsed<Address> {
    Ok(Address::from_slice(&lower_hex(str(value)?, 40)?))
}

/// `^(?:0|[1-9][0-9]*)$` with at most `max_digits` digits.
fn canonical_digits(text: &str, max_digits: usize) -> Parsed<&str> {
    let canonical = !text.is_empty()
        && text.len() <= max_digits
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));

    if canonical { Ok(text) } else { Err(Invalid) }
}

/// TS `Uint256` (`positive = false`) or `Qid` / `ChainId` (`positive = true`):
/// a canonical decimal string below 2^256.
pub(crate) fn decimal_u256(value: &Value, positive: bool) -> Parsed<U256> {
    let number =
        U256::from_str_radix(canonical_digits(str(value)?, 78)?, 10).map_err(|_| Invalid)?;

    if positive && number.is_zero() {
        Err(Invalid)
    } else {
        Ok(number)
    }
}

/// TS `UnixSeconds`: a canonical decimal string below 2^64.
pub(crate) fn decimal_u64(value: &Value) -> Parsed<u64> {
    canonical_digits(str(value)?, 20)?
        .parse()
        .map_err(|_| Invalid)
}

/// TS `Handle`: 1-32 chars, `^[a-z0-9][a-z0-9_]*$`.
pub(crate) fn is_handle(text: &str) -> bool {
    let bytes = text.as_bytes();

    (1..=32).contains(&bytes.len())
        && bytes[0] != b'_'
        && bytes
            .iter()
            .all(|&byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

pub(crate) fn handle(value: &Value) -> Parsed<&str> {
    let text = str(value)?;

    if is_handle(text) {
        Ok(text)
    } else {
        Err(Invalid)
    }
}

/// The TS chat `Uuid` pattern (case-insensitive):
/// `^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
pub(crate) fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();

    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => matches!(byte, b'1'..=b'8'),
            19 => matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_hexdigit(),
        })
}

pub(crate) fn uuid(value: &Value) -> Parsed<&str> {
    let text = str(value)?;

    if is_uuid(text) {
        Ok(text)
    } else {
        Err(Invalid)
    }
}
