//! Key interactions, driven through Rune's headless runtime.

use std::sync::mpsc::{self, Receiver};

use rune::{Env, Key, KeyEvent, Mods, Runtime};

use super::{Pane, Ui, fake, view};
use crate::model::{Command, ConversationId, MessageId, NewChat, Phase};

/// A runtime showing `scene`, and the receiving end of its commands.
fn open(scene: fn(&mut Ui)) -> (Runtime<Ui>, Receiver<Command>) {
    let (tx, rx) = mpsc::channel();
    let mut ui = Ui::new(tx);
    scene(&mut ui);
    let mut rt = Runtime::new(ui, view, (980.0, 660.0), Env::new(false, 2.0));
    rt.frame(0.0);
    (rt, rx)
}

fn click(rt: &mut Runtime<Ui>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("no element keyed {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}

fn press(rt: &mut Runtime<Ui>, key: Key) {
    rt.key(KeyEvent { key, mods: Mods::default() });
    rt.frame(1.0 / 60.0);
}

#[test]
fn typing_a_handle_and_pressing_return_submits_it() {
    let (mut rt, rx) = open(fake::welcome);
    click(&mut rt, "handle");
    press(&mut rt, Key::Text("@Alice ".into()));
    press(&mut rt, Key::Enter);
    assert_eq!(rx.try_recv(), Ok(Command::SubmitHandle("alice".into())));
}

#[test]
fn sending_from_the_composer_emits_send_and_clears_it() {
    let (mut rt, rx) = open(fake::chat);
    click(&mut rt, "composer");
    press(&mut rt, Key::Text("see you at six".into()));
    press(&mut rt, Key::Enter);
    assert_eq!(rx.try_recv(), Ok(Command::Send { conversation: ConversationId("bob".into()), text: "see you at six".into() }));
    assert_eq!(rt.state.composer.text, "");
}

#[test]
fn retry_on_a_failed_message_emits_retry() {
    let (mut rt, rx) = open(fake::chat);
    click(&mut rt, "retry-b7");
    assert_eq!(rx.try_recv(), Ok(Command::Retry(MessageId("b7".into()))));
}

#[test]
fn a_resolved_new_chat_lookup_opens_its_conversation() {
    let (mut rt, rx) = open(fake::linked_list);
    rt.update(|ui, _| {
        ui.pane = Pane::NewChat;
        ui.new_chat_field.replace_text("@Carol");
    });
    rt.update(|ui, _| {
        ui.update_model(|m| {
            if let Phase::Linked(l) = &mut m.phase {
                l.new_chat = NewChat::Resolved { handle: "carol".into(), conversation: ConversationId("carol".into()) };
            }
        })
    });
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.pane, Pane::Chat);
    assert_eq!(rt.state.selected, Some(ConversationId("carol".into())));
    assert_eq!(rx.try_recv(), Ok(Command::OpenConversation(ConversationId("carol".into()))));
}
