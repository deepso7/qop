//! QOP Desktop entry point.
//!
//! - `qop-desktop` opens the window and runs the engine against the configured chain, API and
//!   relays (`config.rs`), with local state in the data directory (`store.rs`).
//! - `qop-desktop --headless [--link HANDLE]` runs the engine without a window and prints each
//!   model change (one line, plus one per message once linked), offer codes included; `--link`
//!   submits the handle when unlinked, and stdin lines stand in for the UI (`read_commands`).
//!   E2e runs drive the desktop this way. `QOP_PRINT_OFFER=1` prints the same lines from the app.
//! - Rune's tooling flags render a scene headless without the engine, e.g.
//!   `--snap out.png --scene chat [--theme dark]` (`--list-scenes` lists them).

mod ui;

use std::process::ExitCode;
use std::sync::{Arc, Mutex, mpsc};

use qop_desktop::config::Config;
use qop_desktop::engine::{Engine, Publish, check_device_key};
use qop_desktop::keys::KeyStore;
use qop_desktop::model::{self, Command, Model, Phase};
use qop_desktop::store::{Store, default_data_dir};
use rune::{App, AppSpec, Titlebar};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use ui::Ui;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--headless") {
        return headless(&args[1..]);
    }
    // Rune's tooling flags: render scenes only, no store, no network.
    if args.iter().any(|arg| arg.starts_with("--")) {
        run_ui(None);
        return ExitCode::SUCCESS;
    }
    match open() {
        Ok(parts) => {
            run_ui(Some(parts));
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("qop: {error}");
            ExitCode::FAILURE
        }
    }
}

struct Parts {
    config: Config,
    store: Store,
    keys: KeyStore,
}

fn open() -> Result<Parts, String> {
    let config = Config::from_env().map_err(|error| error.to_string())?;
    let dir = default_data_dir();
    let store = Store::open(&dir).map_err(|error| error.to_string())?;
    let keys = KeyStore::for_data_dir(&dir);
    check_device_key(&store, &keys)?;
    Ok(Parts { config, store, keys })
}

/// Runs the engine to completion on a multi-threaded tokio runtime (on the calling thread).
fn run_engine(parts: Parts, publish: Publish, commands: UnboundedReceiver<Command>) {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    runtime.block_on(Engine::live(parts.config, parts.store, parts.keys, publish).run(commands));
}

fn run_ui(parts: Option<Parts>) {
    rune::prewarm_gpu();
    let (commands, inbox) = mpsc::channel::<Command>();
    let spec = AppSpec::<Ui> {
        min_size: Some((760.0, 540.0)),
        scenes: ui::fake::SCENES,
        fonts: ui::theme::FONTS,
        families: ui::theme::FAMILIES,
        poll: Some(ui::poll),
        on_key: Some(ui::on_key),
        // Replaced by `init` below; scenes and tests build their own `Ui`.
        ..AppSpec::new("qop", (980.0, 660.0), || Ui::new(mpsc::channel().0), ui::view)
    };
    // Content runs under a 56 pt titlebar band with the traffic lights centred in it.
    let app = App::new(spec).titlebar(Titlebar::new(ui::theme::TITLEBAR)).init(move || Ui::new(commands));
    if let Some(parts) = parts {
        let handle = app.handle();
        let print = std::env::var_os("QOP_PRINT_OFFER").is_some();
        let publish: Publish = Box::new(move |model: &Model| {
            if print {
                println!("{}", describe(model));
            }
            let model = model.clone();
            handle.update(move |ui, _| ui.publish(model));
        });
        let (engine_commands, engine_inbox) = unbounded_channel();
        forward(inbox, engine_commands);
        std::thread::Builder::new()
            .name("qop-engine".into())
            .spawn(move || run_engine(parts, publish, engine_inbox))
            .expect("engine thread");
    }
    app.run();
}

/// The UI sends on a std channel; the engine reads a tokio one.
fn forward(inbox: mpsc::Receiver<Command>, engine: UnboundedSender<Command>) {
    std::thread::Builder::new()
        .name("qop-commands".into())
        .spawn(move || {
            for command in inbox {
                if engine.send(command).is_err() {
                    break;
                }
            }
        })
        .expect("command thread");
}

fn headless(args: &[String]) -> ExitCode {
    let parts = match open() {
        Ok(parts) => parts,
        Err(error) => {
            eprintln!("qop: {error}");
            return ExitCode::FAILURE;
        }
    };
    let (commands, inbox) = unbounded_channel();
    if let Some(handle) = args.windows(2).find(|pair| pair[0] == "--link").map(|pair| pair[1].clone()) {
        // Ignored (and logged) unless the device starts unlinked.
        let _ = commands.send(Command::SubmitHandle(handle));
    }
    // The latest model, so stdin commands can name conversations and messages.
    let latest = Arc::new(Mutex::new(Model::STARTING));
    // The clone keeps the engine running after stdin closes; it ends with the process.
    read_commands(commands.clone(), latest.clone());
    // Store before printing: a script reacting to the line must see this model.
    let publish: Publish = Box::new(move |model: &Model| {
        *latest.lock().unwrap() = model.clone();
        println!("{}", describe(model));
    });
    run_engine(parts, publish, inbox);
    ExitCode::SUCCESS
}

/// Headless stand-ins for the UI, one per stdin line: `link HANDLE`, `regenerate`,
/// `stop-waiting`, `unlink`, `start-over`; once linked, `chat HANDLE` (New chat), `open HANDLE`, `earlier HANDLE`,
/// `send HANDLE TEXT…` and `retry ID-PREFIX`.
fn read_commands(commands: UnboundedSender<Command>, latest: Arc<Mutex<Model>>) {
    std::thread::Builder::new()
        .name("qop-stdin".into())
        .spawn(move || {
            for line in std::io::stdin().lines().map_while(Result::ok) {
                let words: Vec<&str> = line.split_whitespace().collect();
                let model = latest.lock().unwrap().clone();
                let conversation = |handle: &str| match &model.phase {
                    Phase::Linked(l) => l.conversations.iter().find(|c| c.peer == handle).map(|c| c.id.clone()),
                    _ => None,
                };
                let command = match words.as_slice() {
                    ["link", handle] => Some(Command::SubmitHandle((*handle).to_owned())),
                    ["regenerate"] => Some(Command::RegeneratePairing),
                    ["stop-waiting"] => Some(Command::StopWaiting),
                    ["unlink"] => Some(Command::Unlink),
                    ["start-over"] => Some(Command::AcknowledgeRevoked),
                    ["chat", handle] => Some(Command::StartChat((*handle).to_owned())),
                    ["open", handle] => conversation(handle).map(Command::OpenConversation),
                    ["earlier", handle] => conversation(handle).map(Command::LoadEarlier),
                    ["send", handle, ..] => conversation(handle).map(|conversation| Command::Send {
                        conversation,
                        text: words[2..].join(" "),
                    }),
                    ["retry", prefix] => match &model.phase {
                        Phase::Linked(l) => l
                            .conversations
                            .iter()
                            .flat_map(|c| c.messages.iter())
                            .find(|m| m.id.0.starts_with(prefix))
                            .map(|m| Command::Retry(m.id.clone())),
                        _ => None,
                    },
                    [] => continue,
                    _ => {
                        eprintln!("qop: unknown command {line:?}");
                        continue;
                    }
                };
                match command {
                    Some(command) => {
                        let _ = commands.send(command);
                    }
                    None => eprintln!("qop: nothing to {line:?} (start the chat first?)"),
                }
            }
        })
        .expect("stdin thread");
}

/// One line per model, for logs and e2e scripts.
fn describe(model: &Model) -> String {
    let offer = |offer: Option<&model::Offer>| {
        offer.map_or_else(|| "none".into(), |o| format!("{} fingerprint={}", o.code, o.fingerprint))
    };
    match &model.phase {
        Phase::Starting => "phase=Starting".into(),
        Phase::EnterHandle(e) => format!("phase=EnterHandle lookup={:?}", e.lookup),
        Phase::Pairing(p) => format!("phase=Pairing handle={} relay={:?} offer={}", p.handle, p.relay, offer(p.offer.as_ref())),
        Phase::AwaitingEnrollment(a) => format!(
            "phase=AwaitingEnrollment handle={} progress={:?} relay={:?} recovery={}",
            a.handle,
            a.progress,
            a.relay,
            offer(a.recovery.as_ref())
        ),
        Phase::Linked(l) => {
            let mut out = format!(
                "phase=Linked handle={} peer={} fingerprint={} relay={:?} messaging={:?} new_chat={:?} data={}",
                l.account.handle,
                l.account.peer_id,
                l.account.fingerprint,
                l.relay,
                l.messaging,
                l.new_chat,
                l.account.data_dir.display()
            );
            for c in &l.conversations {
                out += &format!("\n  chat @{} unread={}", c.peer, c.unread);
                for m in c.messages.iter() {
                    let direction = match m.direction {
                        model::Direction::Received => "received".into(),
                        model::Direction::Sent(status) => format!("sent:{status:?}"),
                    };
                    out += &format!("\n    {} {direction} {:?}", &m.id.0[..8], m.text);
                }
            }
            out
        }
        Phase::Revoked(r) => format!("phase=Revoked handle={}", r.handle),
    }
}
