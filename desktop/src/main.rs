//! QOP Desktop entry point.
//!
//! `cargo run` opens the window; `cargo run -- --snap out.png --scene chat [--theme dark]` renders
//! a scene headless (`--list-scenes` lists them). Until the engine lands, commands are only logged.

// Some variants are only constructed by the engine, which lands separately.
#[allow(dead_code)]
mod model;
mod ui;

use std::sync::mpsc;

use model::{Command, EnterHandle, HandleLookup, Model, Phase};
use rune::{App, AppSpec};
use ui::Ui;

fn main() {
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
    let app = App::new(spec).init(move || {
        let mut ui = Ui::new(commands);
        ui.publish(Model { phase: Phase::EnterHandle(EnterHandle { lookup: HandleLookup::Idle }) });
        ui
    });
    // Stand-in for the engine: it will own `inbox` and publish through `app.handle()`.
    std::thread::spawn(move || {
        for command in inbox {
            eprintln!("qop: command {command:?}");
        }
    });
    app.run();
}
