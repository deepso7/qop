//! QOP Desktop entry point.

use rune::tok::{self, type_};
use rune::{AppSpec, Cx, El, col, text};

#[derive(Default)]
struct State;

fn view(_: &State, _: &mut Cx<State>) -> El {
    let t = tok::theme(true);
    col().w_full().h_full().center().fill(t.bg).child(text("qop").font(type_::TITLE).color(t.text))
}

fn main() {
    rune::run(AppSpec::new("qop", (960.0, 640.0), State::default, view));
}
