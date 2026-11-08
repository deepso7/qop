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
fn a_message_over_the_limit_is_kept_and_not_sent() {
    let (mut rt, rx) = open(fake::chat);
    click(&mut rt, "composer");
    let draft = "é".repeat(4001);
    press(&mut rt, Key::Text(draft.clone()));
    press(&mut rt, Key::Enter);
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.composer.text, draft);
    assert!(rt.find("composer-error").is_some());
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

/// Frame cost with a 5,000-message conversation open: the thread must stay virtualized, so a
/// frame costs about what a short chat's does. Debug-build numbers; prints them with
/// `cargo test frame_cost -- --nocapture`.
#[test]
fn frame_cost_stays_flat_with_a_long_conversation() {
    use std::time::Instant;

    use crate::model::{Conversation, Direction, Message, MessageStatus};

    const MESSAGES: usize = 5_000;
    fn thread(n: usize) -> Vec<Message> {
        (0..n)
            .map(|i| Message {
                id: MessageId(format!("m{i:05}")),
                direction: if i % 3 == 0 { Direction::Received } else { Direction::Sent(MessageStatus::Sent) },
                text: format!("message {i}: the quick brown fox jumps over the lazy dog"),
                at: std::time::SystemTime::now() - std::time::Duration::from_secs((n - i) as u64 * 30),
            })
            .collect()
    }
    fn long(ui: &mut Ui) {
        fake::linked_list(ui);
        ui.update_model(|m| {
            if let Phase::Linked(l) = &mut m.phase {
                l.conversations[0] = Conversation { messages: thread(MESSAGES).into(), ..l.conversations[0].clone() };
            }
        });
        ui.selected = Some(ConversationId("bob".into()));
    }
    let (mut rt, _rx) = open(long);
    let time = |rt: &mut Runtime<Ui>, change: &mut dyn FnMut(&mut Runtime<Ui>)| {
        let start = Instant::now();
        for _ in 0..20 {
            change(rt);
            rt.frame(1.0 / 60.0);
        }
        start.elapsed().as_secs_f64() * 1000.0 / 20.0
    };
    // Let the arrival springs settle first.
    for _ in 0..120 {
        rt.frame(1.0 / 60.0);
    }
    let idle = time(&mut rt, &mut |_| {});
    // Scrolling up through the thread, a wheel step a frame.
    let (x, y) = rt.find("thread").expect("the thread");
    let scroll = time(&mut rt, &mut |rt| rt.wheel(x, y, 120.0));
    // A new model each frame, as when a message arrives: the view runs again. The threads are
    // built up front, so only the UI's work is timed.
    let mut next: Vec<std::sync::Arc<[Message]>> = (1..=20).map(|n| thread(MESSAGES + n).into()).collect();
    let republish = time(&mut rt, &mut |rt| {
        let messages = next.remove(0);
        rt.update(|ui, _| {
            ui.update_model(|m| {
                if let Phase::Linked(l) = &mut m.phase {
                    l.conversations[0].messages = messages;
                }
            })
        })
    });
    eprintln!(
        "frame cost with {MESSAGES} messages: idle {idle:.2} ms, scrolling {scroll:.2} ms, new message each frame {republish:.2} ms"
    );
    let (mut rt, _rx) = open(fake::chat);
    for _ in 0..120 {
        rt.frame(1.0 / 60.0);
    }
    let short_idle = time(&mut rt, &mut |_| {});
    let short_republish = time(&mut rt, &mut |rt| rt.update(|ui, _| ui.update_model(|_| {})));
    eprintln!("frame cost with 8 messages: idle {short_idle:.2} ms, republish {short_republish:.2} ms");
    // Generous: debug builds of Rune are slow, and CI machines vary. Unvirtualized, this is
    // seconds per frame.
    assert!(republish < 250.0 && scroll < 250.0, "{republish} / {scroll} ms per frame");
}

#[test]
fn the_top_of_a_thread_with_earlier_messages_asks_for_them_once() {
    fn with_earlier(ui: &mut Ui) {
        fake::chat(ui);
        ui.update_model(|m| {
            if let Phase::Linked(l) = &mut m.phase {
                l.conversations[0].earlier = true;
            }
        });
    }
    let (mut rt, rx) = open(with_earlier);
    let (x, y) = rt.find("thread").expect("the thread");
    for _ in 0..30 {
        rt.wheel(x, y, -400.0);
        rt.frame(1.0 / 60.0);
    }
    let asked: Vec<Command> = rx.try_iter().filter(|c| matches!(c, Command::LoadEarlier(_))).collect();
    assert_eq!(asked, [Command::LoadEarlier(ConversationId("bob".into()))]);
}

#[test]
fn unlink_in_settings_asks_once_more_then_unlinks() {
    let (mut rt, rx) = open(fake::settings);
    click(&mut rt, "unlink");
    assert!(rx.try_recv().is_err());
    click(&mut rt, "unlink-yes");
    assert_eq!(rx.try_recv(), Ok(Command::Unlink));
}

#[test]
fn start_over_leaves_the_revoked_screen() {
    let (mut rt, rx) = open(fake::revoked);
    click(&mut rt, "start-over");
    assert_eq!(rx.try_recv(), Ok(Command::AcknowledgeRevoked));
}
