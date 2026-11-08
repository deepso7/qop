//! QOP Desktop entry point.
//!
//! - `qop-desktop` opens the window and runs the engine against the configured chain, API and
//!   relays (`config.rs`), with local state in the data directory (`store.rs`).
//! - `qop-desktop --headless [--link HANDLE]` runs the engine without a window and prints one
//!   line per model change, offer codes included; `--link` submits the handle when unlinked,
//!   and stdin lines stand in for the buttons (`read_commands`).
//!   E2e runs drive the desktop this way. `QOP_PRINT_OFFER=1` prints the same lines from the app.
//! - Rune's tooling flags render a scene headless without the engine, e.g.
//!   `--snap out.png --scene chat [--theme dark]` (`--list-scenes` lists them).

mod ui;

use std::process::ExitCode;
use std::sync::mpsc;

use qop_desktop::config::Config;
use qop_desktop::engine::{Engine, Publish};
use qop_desktop::keys::KeyStore;
use qop_desktop::model::{self, Command, Model, Phase};
use qop_desktop::store::{Store, default_data_dir};
use rune::{App, AppSpec};
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
    Ok(Parts { config, store, keys: KeyStore::for_data_dir(&dir) })
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
    let app = App::new(spec).init(move || Ui::new(commands));
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
    // The clone keeps the engine running after stdin closes; it ends with the process.
    read_commands(commands.clone());
    let publish: Publish = Box::new(|model: &Model| println!("{}", describe(model)));
    run_engine(parts, publish, inbox);
    ExitCode::SUCCESS
}

/// Headless stand-ins for the UI's buttons, one per stdin line: `link HANDLE`, `regenerate`,
/// `stop-waiting`, `unlink`, `start-over`.
fn read_commands(commands: UnboundedSender<Command>) {
    std::thread::Builder::new()
        .name("qop-stdin".into())
        .spawn(move || {
            for line in std::io::stdin().lines().map_while(Result::ok) {
                let command = match line.split_whitespace().collect::<Vec<_>>().as_slice() {
                    ["link", handle] => Command::SubmitHandle((*handle).to_owned()),
                    ["regenerate"] => Command::RegeneratePairing,
                    ["stop-waiting"] => Command::StopWaiting,
                    ["unlink"] => Command::Unlink,
                    ["start-over"] => Command::AcknowledgeRevoked,
                    [] => continue,
                    _ => {
                        eprintln!("qop: unknown command {line:?}");
                        continue;
                    }
                };
                let _ = commands.send(command);
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
        Phase::Linked(l) => format!(
            "phase=Linked handle={} peer={} fingerprint={} relay={:?} data={}",
            l.account.handle,
            l.account.peer_id,
            l.account.fingerprint,
            l.relay,
            l.account.data_dir.display()
        ),
        Phase::Revoked(r) => format!("phase=Revoked handle={}", r.handle),
    }
}
