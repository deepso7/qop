//! Key interactions, driven through Rune's headless runtime.

use std::sync::mpsc::{self, Receiver};

use rune::{Color, Env, Key, KeyEvent, Mods, Runtime};

use super::{Pane, Ui, fake, view};
use super::theme::Theme;
use crate::model::{Command, ConversationId, MessageId, NewChat, Phase};

#[test]
fn text_links_draw_ink_on_hover() {
    fn link(&(danger, dark): &(bool, bool), _: &mut rune::Cx<(bool, bool)>) -> rune::El {
        let t = Theme::new(dark);
        if danger {
            super::kit::danger_link(&t, "link", "Use another handle", |_: &mut (bool, bool), _| {})
        } else {
            super::kit::link(&t, "link", "Copy", super::theme::type_::SMALL, |_: &mut (bool, bool), _| {})
        }
    }
    for dark in [false, true] {
        for danger in [false, true] {
            let mut rt = Runtime::new((danger, dark), link, (300.0, 60.0), Env::new(dark, 2.0));
            rt.frame(0.0);
            let (x, y) = rt.find("link").unwrap();
            rt.pointer_move(x, y);
            for _ in 0..120 { rt.frame(1.0 / 60.0); }
            let glyphs: Vec<_> = rt.instances.iter().filter(|i| i.params[1] == rune::render::KIND_GLYPH).collect();
            assert!(!glyphs.is_empty());
            let t = Theme::new(dark);
            for glyph in glyphs {
                let ink = [t.ink.r, t.ink.g, t.ink.b, t.ink.a];
                assert!(glyph.fill.iter().zip(ink).all(|(a, b)| (a - b).abs() < 1e-6), "danger={danger} dark={dark}: drawn {:?}, expected ink {ink:?}", glyph.fill);
            }
        }
    }
}

#[test]
fn text_links_keep_interaction_on_the_hover_group() {
    fn links(_: &usize, _: &mut rune::Cx<usize>) -> rune::El {
        let t = Theme::new(false);
        rune::col()
            .child(super::kit::link(&t, "plain", "Copy", super::theme::type_::SMALL, |n: &mut usize, _| *n += 1))
            .child(super::kit::danger_link(&t, "danger", "Use another handle", |n: &mut usize, _| *n += 1))
    }
    let mut rt = Runtime::new(0, links, (980.0, 660.0), Env::new(false, 2.0));
    rt.frame(0.0);
    for (key, label, color) in [("plain", "Copy", Theme::new(false).link), ("danger", "Use another handle", Theme::new(false).danger)] {
        let elements = rt.elements();
        let index = elements.iter().position(|e| e.key.as_deref() == Some(key)).unwrap();
        let button = &elements[index];
        assert_eq!(button.role, "button");
        assert_eq!(button.label.as_deref(), Some(label));
        assert!(button.focusable);
        let text = elements.iter().find(|e| e.parent == Some(index) && e.text.as_deref() == Some(label)).unwrap();
        assert_eq!(text.text_color, Some(color));
        assert_eq!(&button.rect[..2], &text.rect[..2]);
        assert_eq!(button.rect[3], text.rect[3]);
        let (x, y) = rt.find(key).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
    }
    rt.key(KeyEvent { key: Key::Tab, mods: Mods::default() });
    rt.frame(1.0 / 60.0);
    rt.key(KeyEvent { key: Key::Text(" ".into()), mods: Mods::default() });
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state, 3);
}

#[test]
fn ink_text_meets_aa_on_paper_and_panels() {
    let luminance = |c: Color| 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    for dark in [false, true] {
        let t = Theme::new(dark);
        for (name, surface) in [("paper", t.paper), ("panel", t.element)] {
            let a = luminance(t.ink);
            let b = luminance(surface);
            let ratio = (a.max(b) + 0.05) / (a.min(b) + 0.05);
            println!("ink dark={dark} {name}: {ratio:.2}:1");
            assert!(ratio >= 4.5);
        }
    }
}

#[test]
fn danger_text_meets_aa_on_surfaces_and_hovered_chips() {
    let luminance = |c: Color| 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    for dark in [false, true] {
        let t = Theme::new(dark);
        assert_eq!(t.danger.hex(), if dark { "#fa6863ff" } else { "#c2181dff" });
        for (name, surface) in [("paper", t.paper), ("panel", t.element)] {
            let chip = surface.mix(t.danger, t.danger_chip.a);
            let hover = chip.mix(t.danger, t.danger_hover.a);
            for (state, background) in [("plain", surface), ("chip", chip), ("hover", hover)] {
                let a = luminance(t.danger);
                let b = luminance(background);
                let ratio = (a.max(b) + 0.05) / (a.min(b) + 0.05);
                println!("danger dark={dark} {name} {state}: {ratio:.2}:1");
                assert!(ratio >= 4.5);
            }
        }
    }
}

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
fn editing_the_handle_hides_the_lookup_error_for_the_old_one() {
    let (mut rt, _rx) = open(fake::welcome_error);
    assert!(rt.find("handle-error").is_some());
    click(&mut rt, "handle");
    press(&mut rt, Key::Text("x".into()));
    assert!(rt.find("handle-error").is_none());
}

#[test]
fn tab_reaches_a_conversation_row_and_space_opens_it() {
    let (mut rt, rx) = open(fake::linked_list);
    press(&mut rt, Key::Tab); // Settings
    press(&mut rt, Key::Tab); // New chat
    press(&mut rt, Key::Tab);
    press(&mut rt, Key::Text(" ".into()));
    assert_eq!(rx.try_recv(), Ok(Command::OpenConversation(ConversationId("bob".into()))));
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
fn switching_chats_does_not_carry_the_draft() {
    let (mut rt, _rx) = open(fake::chat);
    click(&mut rt, "composer");
    press(&mut rt, Key::Text("for bob only".into()));
    click(&mut rt, "c-carol");
    assert_eq!(rt.state.selected, Some(ConversationId("carol".into())));
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
fn a_message_that_encodes_over_the_byte_cap_is_kept_and_not_sent() {
    let (mut rt, rx) = open(fake::chat);
    click(&mut rt, "composer");
    // Pasted (typing drops control characters): 4,000 characters fit the limit, but each
    // encodes as `\u0001`, about 24 KiB.
    let draft = "\u{1}".repeat(4000);
    rt.paste(draft.clone());
    rt.frame(1.0 / 60.0);
    press(&mut rt, Key::Enter);
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.composer.text, draft);
    assert!(rt.find("composer-error").is_some());
}

#[test]
fn leaving_the_chat_pane_closes_the_conversation_and_returning_reopens_it() {
    let (mut rt, rx) = open(fake::chat);
    click(&mut rt, "new-chat");
    assert_eq!(rt.state.pane, Pane::NewChat);
    assert_eq!(rx.try_recv(), Ok(Command::CloseConversation));
    click(&mut rt, "cancel-new-chat");
    assert_eq!(rt.state.pane, Pane::Chat);
    assert_eq!(rx.try_recv(), Ok(Command::OpenConversation(ConversationId("bob".into()))));
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

#[test]
fn distro_name_drops_the_linux_suffix() {
    assert_eq!(super::distro_name("ID=ubuntu\nNAME=\"Ubuntu\"\n").as_deref(), Some("Ubuntu"));
    assert_eq!(super::distro_name("NAME=\"Fedora Linux\"").as_deref(), Some("Fedora"));
    assert_eq!(super::distro_name("NAME='Debian GNU/Linux'").as_deref(), Some("Debian"));
    assert_eq!(super::distro_name("ID=void"), None);
}

#[test]
fn pairing_steps_read_with_their_numbers() {
    let (rt, _rx) = open(fake::pairing);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("1. Open qop on your phone"), "{tree}");
    assert!(tree.contains("3. Scan this code and approve"));
}
