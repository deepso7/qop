//! The linked app: conversation sidebar, chat, New chat and Settings.

use rune::{Cursor, El, GrowthSpec, ScrollSpec, Transition, auto_grow, col, el, row, spacer, text, text_input};

use super::kit::{self, Field, Kind, Notch, notched};
use super::onboard::relay_line;
use super::theme::{TITLEBAR, Theme, motion, space, type_};
use super::{Pane, Ui, ago, normalize_handle};
use crate::model::{
    Command, Conversation, Direction, HandleLookup, Linked, LookupError, Message, MessageStatus, Messaging, NewChat,
};

const SIDEBAR: f32 = 280.0;

pub fn linked(ui: &Ui, t: &Theme, l: &Linked) -> El {
    let main = match ui.pane {
        Pane::NewChat => ("new-chat", new_chat(ui, t, l)),
        Pane::Settings => ("settings", settings(ui, t, l)),
        Pane::Chat => match ui.selected.as_ref().and_then(|id| l.conversation(id)) {
            Some(c) => ("chat", chat(ui, t, l, c)),
            None => ("no-chat", col().w_full().h_full().children(notice(t, l)).child(no_chat(t, l).grow(1.0).min_h(0.0))),
        },
    };
    let swap = Transition::opacity().springs(motion::SWAP);
    row()
        .child(sidebar(ui, t, l))
        .child(col().key("main").grow(1.0).h_full().min_w(0.0).fill(t.sheet).child(main.1.key(main.0).w_full().h_full().transition(swap)))
}

fn sidebar(ui: &Ui, t: &Theme, l: &Linked) -> El {
    let list = if l.conversations.is_empty() {
        col().key("list-empty").padding(space::L).child(text("No chats yet.").font(type_::SMALL).color(t.muted))
    } else {
        let rows = l.conversations.iter().fold(col().key("conversations").w_full().px(space::S), |c, conv| c.child(conversation_row(ui, t, conv)));
        col().key("list").grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).scroll_edge_fade(12.0).child(rows)
    };
    let header = row()
        .key("sidebar-head")
        .h(TITLEBAR)
        .pl(t.band_lead(space::L))
        .pr(space::L)
        .items_center()
        .window_drag()
        .child(kit::wordmark(t.ink, 13.0))
        .child(spacer())
        .child(kit::button(t, "new-chat", "New chat", if ui.pane == Pane::NewChat { Kind::Primary } else { Kind::Secondary }, |ui: &mut Ui, _| ui.show(Pane::NewChat)));
    let footer = row()
        .key("sidebar-foot")
        .h(52.0)
        .px(space::L)
        .gap(space::S)
        .items_center()
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border)
        .child(relay_dot(t, l))
        .child(text(format!("@{}", l.account.handle)).font(type_::LABEL).color(t.ink).truncate().shrink())
        .child(spacer())
        .child(kit::icon_button(t, "open-settings", "Settings", kit::gear(t.ink, 15.0), if ui.pane == Pane::Settings { Kind::Secondary } else { Kind::Quiet }, |ui: &mut Ui, _| ui.show(Pane::Settings)));
    col()
        .key("sidebar")
        .w(SIDEBAR)
        .h_full()
        .fill(t.paper)
        .border_sides([0.0, 1.0, 0.0, 0.0], t.border)
        .child(header)
        .child(list.grow(1.0).min_h(0.0))
        .child(footer)
}

fn relay_dot(t: &Theme, l: &Linked) -> El {
    use crate::model::RelayStatus::*;
    let (c, ring) = match (l.messaging, l.relay) {
        _ if l.trouble.is_some() => (t.link, true),
        (Messaging::Verifying, _) | (_, Connecting) => (t.muted, true),
        (_, Connected) => (t.brand, false),
        (_, LocalOnly) => (t.muted, false),
        (_, Offline) => (t.link, true),
    };
    kit::dot(c, ring)
}

/// A notched initial; terracotta for the open conversation.
fn avatar(t: &Theme, peer: &str, selected: bool) -> El {
    let initial = peer.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default();
    let (fill, ink) = if selected { (t.accent, t.on_accent) } else { (t.element, t.ink) };
    notched(el().size(32.0, 32.0).center(), Notch::Small, fill, None).child(text(initial).font(type_::LABEL).color(ink)).a11y_hidden()
}

fn conversation_row(ui: &Ui, t: &Theme, c: &Conversation) -> El {
    let selected = ui.pane == Pane::Chat && ui.selected.as_ref() == Some(&c.id);
    let preview = c.last().map_or(String::new(), |m| match m.direction {
        Direction::Received => m.text.clone(),
        Direction::Sent(_) => format!("You: {}", m.text),
    });
    let when = c.last().map_or(String::new(), |m| ago(m.at, ui.now));
    let id = c.id.clone();
    let mut meta = col().gap(space::XS).items_end().child(text(when).font(type_::CAPTION).color(t.muted));
    if c.unread > 0 {
        meta = meta.child(kit::badge(t, c.unread).key("unread").transition(Transition::scale(0.7).allow_small_scale().springs(motion::ARRIVE)));
    }
    let base = row().key(format!("c-{}", c.id.0)).h(60.0).px(space::S).gap(space::M).items_center();
    let base = if selected { notched(base, Notch::Small, t.element, None) } else { base };
    let base = if selected { base } else { base.child(kit::hover_wash(Notch::Small, t.hover)) };
    base
    .child(avatar(t, &c.peer, selected))
    .child(
        col()
            .grow(1.0)
            .min_w(0.0)
            .gap(2.0)
            .child(text(format!("@{}", c.peer)).font(if c.unread > 0 { type_::HEADING } else { type_::LABEL }).color(t.ink).truncate())
            .child(text(preview).font(type_::SMALL).color(t.muted).truncate()),
    )
    .child(meta)
    .role("button")
    .label(format!("@{}", c.peer))
    .hover_group()
    .focusable(true)
    .focus_ring(2.0, 0.0, t.brand)
    .cursor(Cursor::Pointer)
    .on_press(move |ui: &mut Ui| ui.open(id.clone()))
    .transition(Transition::offset(-8.0, 0.0).combined(Transition::opacity()).springs(motion::ARRIVE))
}

fn no_chat(t: &Theme, l: &Linked) -> El {
    let (title, sub) = if l.conversations.is_empty() {
        ("Say hello", "Your chats with qop contacts show up here. Start one with their handle.")
    } else {
        ("Pick a chat", "Choose a conversation on the left, or start a new one.")
    };
    col()
        .w_full()
        .h_full()
        .center()
        .child(
            col()
                .w(340.0)
                .gap(space::S)
                .items_center()
                .child(kit::mark(t, 40.0, false))
                .child(el().h(space::S))
                .child(text(title).font(type_::TITLE).color(t.ink))
                .child(text(sub).font(type_::BODY).color(t.muted).wrap().align(rune::Align::Center))
                .child(el().h(space::S))
                .child(kit::button(t, "empty-new-chat", "New chat", Kind::Primary, |ui: &mut Ui, _| ui.show(Pane::NewChat))),
        )
}

fn chat(ui: &Ui, t: &Theme, l: &Linked, c: &Conversation) -> El {
    let header = row()
        .key("chat-head")
        .h(TITLEBAR)
        .window_drag()
        .px(space::XL)
        .gap(space::M)
        .items_center()
        .border_sides([0.0, 0.0, 1.0, 0.0], t.border)
        .child(avatar(t, &c.peer, false))
        .child(text(format!("@{}", c.peer)).font(type_::HEADING).color(t.ink));
    col().w_full().h_full().child(header).children(notice(t, l)).child(thread(t, c)).child(composer(ui, t))
}

/// One calm line under the header when messaging can't run normally: the chain unreachable,
/// membership being re-checked, or no network at all. Nothing is lost meanwhile; it says so.
fn notice(t: &Theme, l: &Linked) -> Option<El> {
    use crate::model::RelayStatus;
    let pulse = rune::Cycle { period: 1.2, phase: 0.0, stops: &[(0.0, 1.0), (0.5, 0.25), (1.0, 1.0)], still: 1.0, fps: 30.0 };
    let (key, mark, words) = if l.trouble.is_some() {
        ("unreachable", kit::dot(t.link, true), "Can't reach the qop network. Messages wait here and go out once it's back.")
    } else if l.messaging == Messaging::Verifying {
        ("verifying", kit::dot(t.brand, true).cycle(pulse), "Re-checking this Mac's membership. Messages queue until it's done.")
    } else if l.relay == RelayStatus::Offline {
        ("offline", kit::dot(t.link, true), "This Mac is offline. Messages wait here and go out once it reconnects.")
    } else {
        return None;
    };
    Some(
        row()
            .key(key)
            .px(space::XL)
            .py(space::S)
            .gap(space::S)
            .items_center()
            .fill(t.tint)
            .child(mark)
            .child(text(words).font(type_::SMALL).color(t.ink).wrap().grow(1.0).min_w(0.0))
            .transition(Transition::opacity().springs(motion::SWAP)),
    )
}

/// The message list: only the rows on screen (and a little either side) are built, so a long
/// conversation costs what a short one does. It follows the bottom as messages arrive, and
/// reaching the top asks the engine for a page of older ones.
fn thread(t: &Theme, c: &Conversation) -> El {
    let t = *t;
    let last_delivered = c.messages.iter().rposition(|m| m.direction == Direction::Sent(MessageStatus::Sent));
    let (id, earlier, count) = (c.id.clone(), c.earlier, c.messages.len());
    let rows = col()
        .key("messages")
        .w_full()
        .px(space::XL)
        .growth(GrowthSpec::default())
        .virtual_rows(
            count,
            48.0,
            |ui: &Ui, i| ui.thread().map_or("".into(), |m| m[i].id.0.as_str().into()),
            move |ui: &Ui, i| {
                let messages = ui.thread().unwrap_or_default();
                let Some(m) = messages.get(i) else { return el() };
                let run_ends = messages.get(i + 1).is_none_or(|n| std::mem::discriminant(&n.direction) != std::mem::discriminant(&m.direction));
                message(ui, &t, m, run_ends, last_delivered == Some(i))
            },
        )
        // Rows keep their keys unless the conversation or its first message changes.
        .virtual_rows_version((&c.id.0, c.messages.first().map(|m| &m.id.0)))
        .on_visible_rows(move |ui: &mut Ui, rows| {
            if earlier && rows.start == 0 {
                ui.load_earlier(&id, count);
            }
            false
        });
    // The virtual stack must be the scroll viewport's first child; the viewport pads it.
    col()
        .key("thread")
        .grow(1.0)
        .min_h(0.0)
        .pt(space::L)
        .pb(space::XS)
        .scroll(ScrollSpec { stick_bottom: true })
        .scroll_edge_fade(16.0)
        .child(rows)
}

fn message(ui: &Ui, t: &Theme, m: &Message, run_ends: bool, last_delivered: bool) -> El {
    let sent = matches!(m.direction, Direction::Sent(_));
    let (fill, border) = if sent { (t.tint, Some(t.tint_border)) } else { (t.element, None) };
    let bubble = notched(col().max_w(460.0).px(space::M).py(space::S), Notch::Small, fill, border)
        .child(text(m.text.clone()).font(type_::BODY).color(t.ink).wrap().selectable(true));
    let mut meta = row().key("meta").gap(space::S).items_center();
    let status = match m.direction {
        Direction::Sent(MessageStatus::Queued) => Some(row().key("queued").gap(6.0).items_center().child(kit::dot(t.muted, true)).child(text("Queued").font(type_::CAPTION).color(t.muted))),
        Direction::Sent(MessageStatus::Sent) if last_delivered => {
            Some(row().key("delivered").gap(6.0).items_center().child(kit::dot(t.muted, false)).child(text("Delivered").font(type_::CAPTION).color(t.muted)))
        }
        Direction::Sent(MessageStatus::Failed) => {
            let id = m.id.clone();
            Some(
                row()
                    .key("failed")
                    .gap(6.0)
                    .items_center()
                    .child(kit::dot(t.link, false))
                    .child(text("Not delivered").font(type_::CAPTION).color(t.link))
                    .child(text("·").font(type_::CAPTION).color(t.muted))
                    .child(kit::link(t, &format!("retry-{}", m.id.0), "Retry", move |ui: &mut Ui, _| ui.send(Command::Retry(id.clone()))).font(type_::CAPTION)),
            )
        }
        _ => None,
    };
    let show_time = run_ends || status.is_some();
    if show_time {
        meta = meta.child(text(ago(m.at, ui.now)).font(type_::CAPTION).color(t.muted));
    }
    if let Some(s) = status {
        // Keyed by status, so a change crossfades in place.
        meta = meta.child(s.transition(Transition::opacity().springs(motion::SWAP)));
    }
    let mut body = col().gap(space::XS).child(bubble);
    body = if sent { body.items_end() } else { body.items_start() };
    if show_time {
        body = body.child(meta);
    }
    let pad_bottom = if run_ends { space::M } else { 3.0 };
    let row = row().key(format!("m-{}", m.id.0)).w_full().pb(pad_bottom).child(body);
    let row = if sent { row.justify_end() } else { row.justify_start() };
    row.transition(Transition::offset(0.0, 14.0).combined(Transition::opacity()).springs(motion::ARRIVE))
}

fn composer(ui: &Ui, t: &Theme) -> El {
    let border = if ui.composer.focused { t.brand } else { t.border };
    let input = text_input(&ui.composer, type_::BODY)
        .key("composer")
        .grow(1.0)
        .color(t.ink)
        .caret(t.brand, t.tint)
        .placeholder("Message", t.muted)
        .on_edit(|ui: &mut Ui| &mut ui.composer)
        .on_submit(|ui: &mut Ui, _| ui.send_message());
    // Grow with the draft up to eight lines, then scroll inside, so Send stays on screen.
    let input = auto_grow(input, 1, 8).key("composer-scroll");
    let field = notched(col().key("composer-box").grow(1.0).min_h(40.0).px(space::M).py(10.0), Notch::Small, t.paper, Some(border)).child(input);
    let bar = row()
        .key("composer-bar")
        .px(space::XL)
        .py(space::M)
        .gap(space::S)
        .items_end()
        .border_sides([1.0, 0.0, 0.0, 0.0], t.border)
        .child(field)
        .child(kit::button(t, "send", "Send", Kind::Primary, |ui: &mut Ui, _| ui.send_message()).h(40.0));
    // Over the limit: say so above the bar; the draft stays until it is short enough to send.
    let Some(error) = ui.composer_error() else { return bar };
    col()
        .w_full()
        .child(text(error).key("composer-error").font(type_::SMALL).color(t.link).px(space::XL).pb(space::XS))
        .child(bar)
}

fn new_chat(ui: &Ui, t: &Theme, l: &Linked) -> El {
    let typed = normalize_handle(&ui.new_chat_field.text);
    // Only show a lookup result for the handle currently typed.
    let status = match &l.new_chat {
        NewChat::Lookup(HandleLookup::Resolving { handle }) if *handle == typed => Some((t.muted, format!("Looking up @{handle}…"))),
        NewChat::Lookup(HandleLookup::Failed { handle, error }) if *handle == typed => Some((
            t.link,
            match error {
                LookupError::Invalid => "Handles use letters, numbers and underscores.".to_owned(),
                LookupError::NotFound => format!("No one on qop is called @{handle}."),
                LookupError::Unreachable => "Couldn't reach the network. Try again in a moment.".to_owned(),
            },
        )),
        _ => None,
    };
    let field = Field { key: "new-chat-handle", edit: &ui.new_chat_field, placeholder: "their handle", prefix: Some("@") }
        .build(t, |ui: &mut Ui| &mut ui.new_chat_field, |ui: &mut Ui, _| ui.start_chat());
    let mut form = col()
        .w(380.0)
        .gap(space::S)
        .child(text("New chat").font(type_::TITLE).color(t.ink))
        .child(text("Message anyone on qop by their handle.").font(type_::BODY).color(t.muted))
        .child(el().h(space::M))
        .child(field);
    if let Some((color, s)) = status {
        form = form.child(text(s).key("lookup").font(type_::SMALL).color(color).transition(Transition::opacity().springs(motion::SWAP)));
    }
    col().w_full().h_full().padding(space::XXL).child(
        form.child(el().h(space::S)).child(
            row()
                .gap(space::S)
                .child(kit::button(t, "start-chat", "Start chat", Kind::Primary, |ui: &mut Ui, _| ui.start_chat()).default_button())
                .child(kit::button(t, "cancel-new-chat", "Cancel", Kind::Quiet, |ui: &mut Ui, _| ui.show(Pane::Chat))),
        ),
    )
}

fn settings(ui: &Ui, t: &Theme, l: &Linked) -> El {
    let a = &l.account;
    let peer = a.peer_id.clone();
    let section = |title: &str, rows: Vec<(&str, El)>| {
        let card = rows.into_iter().enumerate().fold(kit::card(t, col().px(space::L)), |card, (i, (label, value))| {
            let r = row().h(48.0).gap(space::L).items_center().child(text(label).font(type_::BODY).color(t.muted).w(130.0)).child(value);
            card.child(if i > 0 { r.border_sides([1.0, 0.0, 0.0, 0.0], t.border) } else { r })
        });
        col().gap(space::S).child(kit::caption(t, title)).child(card)
    };
    let value = |s: String| text(s).font(type_::BODY).color(t.ink).truncate_middle().grow(1.0).min_w(0.0);
    let (dot, state) = match (l.messaging, l.trouble) {
        (_, Some(_)) => (kit::dot(t.link, true), "Linked · can't reach the network"),
        (Messaging::Ready, None) => (kit::dot(t.brand, false), "Linked"),
        (Messaging::Verifying, None) => (kit::dot(t.muted, true), "Linked · re-checking membership"),
    };
    let linked_state = row().gap(space::S).items_center().child(dot).child(text(state).font(type_::BODY).color(t.ink));
    let unlink = if ui.confirm_unlink {
        row()
            .key("unlink-confirm")
            .gap(space::S)
            .child(kit::button(t, "unlink-yes", &format!("Unlink @{}", a.handle), Kind::Danger, |ui: &mut Ui, _| ui.send(Command::Unlink)))
            .child(kit::button(t, "unlink-no", "Keep linked", Kind::Quiet, |ui: &mut Ui, _| ui.confirm_unlink = false))
    } else {
        row().key("unlink-ask").child(kit::button(t, "unlink", "Unlink this Mac", Kind::Danger, |ui: &mut Ui, _| ui.confirm_unlink = true))
    };
    let body = col()
        .w_full()
        .max_w(620.0)
        .gap(space::XL)
        .child(text("Settings").font(type_::TITLE).color(t.ink))
        .child(section("Account", vec![("Handle", value(format!("@{}", a.handle))), ("Link state", linked_state)]))
        .child(section(
            "This Mac",
            vec![
                (
                    "Peer ID",
                    row()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(space::M)
                        .items_center()
                        .child(value(a.peer_id.clone()))
                        .child(kit::link(t, "copy-peer", "Copy", move |_: &mut Ui, tx| tx.copy(peer.clone()))),
                ),
                ("Fingerprint", row().child(kit::chip(t, kit::group(&a.fingerprint)))),
                ("Relay", relay_line(t, l.relay)),
                ("Data", value(a.data_dir.display().to_string())),
            ],
        ))
        .child(
            col().gap(space::S).child(kit::caption(t, "Unlink")).child(
                kit::card(t, col().padding(space::L).gap(space::M))
                    .child(
                        text("Signs this Mac out and erases its key and messages here. Also remove it on your phone under Profile → Devices.")
                            .font(type_::BODY)
                            .color(t.muted)
                            .wrap(),
                    )
                    .child(unlink.transition(Transition::opacity().springs(motion::SWAP))),
            ),
        );
    col().key("settings-scroll").w_full().h_full().scroll(ScrollSpec { stick_bottom: false }).child(col().w_full().padding(space::XXL).child(body))
}
