//! Where the desktop reads the chain, the API and relays (`cli/src/config.ts`).
//!
//! The same variables as the CLI, so one `.env` drives both:
//!
//! | Variable | Meaning | Default |
//! | --- | --- | --- |
//! | `QOP_RPC_URL` | JSON-RPC endpoint of the registry's chain | required |
//! | `QOP_REGISTRY_ADDRESS` | Registry contract | required |
//! | `QOP_REGISTRY_CHAIN_ID` | Chain ID | `31337` |
//! | `QOP_API_URL` | Device-action API (status polling) | none: status is unknown |
//! | `QOP_RELAY_ADDRS` | Comma-separated relay peer addresses | none: LAN only |
//! | `QOP_LISTEN_ADDRS` | Comma-separated listen multiaddrs | dual-stack QUIC, ephemeral ports |
//!
//! Public endpoints only; nothing here is secret. Production values are not baked in yet: they
//! are unconfirmed (`docs/research/desktop-app-plan.md`, Risks).

use std::fmt;

use alloy_primitives::{Address, U256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub rpc_url: String,
    pub registry: Address,
    pub chain_id: U256,
    /// Without a trailing slash.
    pub api_url: Option<String>,
    pub relays: Vec<String>,
    /// Listen multiaddrs; empty means dual-stack QUIC on ephemeral ports.
    pub listen: Vec<String>,
}

/// Which variable is missing or malformed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigError {
    RpcUrl,
    Registry,
    ChainId,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::RpcUrl => "QOP_RPC_URL is not set",
            Self::Registry => "QOP_REGISTRY_ADDRESS is not a 0x-prefixed 20-byte address",
            Self::ChainId => "QOP_REGISTRY_CHAIN_ID is not a positive decimal chain ID",
        })
    }
}

impl Config {
    pub fn from_env() -> Result<Config, ConfigError> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// Reads the variables through `var`, so tests need not touch the process environment.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Config, ConfigError> {
        let set = |name| {
            var(name)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let rpc_url = set("QOP_RPC_URL").ok_or(ConfigError::RpcUrl)?;
        let registry = set("QOP_REGISTRY_ADDRESS")
            .filter(|address| address.len() == 42 && address.starts_with("0x"))
            .and_then(|address| address.parse().ok())
            .ok_or(ConfigError::Registry)?;
        let chain_id = set("QOP_REGISTRY_CHAIN_ID")
            .unwrap_or_else(|| "31337".into())
            .parse::<U256>()
            .ok()
            .filter(|id| !id.is_zero())
            .ok_or(ConfigError::ChainId)?;
        let api_url = set("QOP_API_URL").map(|url| url.trim_end_matches('/').to_owned());
        let list = |name| {
            set(name)
                .map(|list| {
                    list.split(',')
                        .map(str::trim)
                        .filter(|a| !a.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        };

        Ok(Config {
            rpc_url,
            registry,
            chain_id,
            api_url,
            relays: list("QOP_RELAY_ADDRS"),
            listen: list("QOP_LISTEN_ADDRS"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn reads_the_cli_variables_with_its_defaults() {
        let config = Config::from_vars(vars(&[
            ("QOP_RPC_URL", "http://127.0.0.1:8545"),
            (
                "QOP_REGISTRY_ADDRESS",
                "0x5FbDB2315678afecb367f032d93F642f64180aa3",
            ),
            ("QOP_API_URL", "http://127.0.0.1:3000/"),
            (
                "QOP_RELAY_ADDRS",
                " /dns/a/udp/1/quic-v1/p2p/x , ,/ip4/1.2.3.4/udp/1/quic-v1/p2p/y",
            ),
        ]))
        .expect("valid");

        assert_eq!(config.chain_id, U256::from(31337));
        assert_eq!(config.api_url.as_deref(), Some("http://127.0.0.1:3000"));
        assert_eq!(
            config.relays,
            [
                "/dns/a/udp/1/quic-v1/p2p/x",
                "/ip4/1.2.3.4/udp/1/quic-v1/p2p/y"
            ]
        );
    }

    #[test]
    fn rejects_missing_or_malformed_values() {
        let registry: (&str, &str) = (
            "QOP_REGISTRY_ADDRESS",
            "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        );
        assert_eq!(
            Config::from_vars(vars(&[registry])),
            Err(ConfigError::RpcUrl)
        );
        assert_eq!(
            Config::from_vars(vars(&[
                ("QOP_RPC_URL", "http://x"),
                ("QOP_REGISTRY_ADDRESS", "0x12")
            ])),
            Err(ConfigError::Registry)
        );
        assert_eq!(
            Config::from_vars(vars(&[
                ("QOP_RPC_URL", "http://x"),
                registry,
                ("QOP_REGISTRY_CHAIN_ID", "0")
            ])),
            Err(ConfigError::ChainId)
        );
    }
}
