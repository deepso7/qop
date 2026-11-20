//! The linked app: conversation sidebar, chat, New chat and Settings. Laid out like qop.sh's
//! docs: a calm sidebar on the same paper as the content, muted rows that turn ink when open,
//! soft squircle surfaces and no divider chrome.

use rune::{Color, Cursor, El, GrowthSpec, ScrollSpec, Transition, auto_grow, col, el, row, spacer, text, text_input};

use super::kit::{self, Field, Kind};
use super::onboard::relay_line;
use super::theme::{TITLEBAR, Theme, motion, radius, space, type_};
use super::{Pane, Ui, ago, normalize_handle};
use crate::model::{
    Command, Conversation, Direction, HandleLookup, Linked, LookupError, Message, MessageStatus, Messaging, NewChat,
};

const SIDEBAR: f32 = 272.0;
/// Horizontal inset of the main panes, so the chat header, thread, composer and the New chat and
/// Settings pages share one left edge.
const GUTTER: f32 = 32.0;

pub fn linked(ui: &Ui, t: &Theme, l: &Linked) -> El {
    let main = match ui.pane {
        Pane::NewChat => ("new-chat", new_chat(ui, t, l)),
        Pane::Settings => ("settings", settings(ui, t, l)),
        Pane::Chat => match ui.selected.as_ref().and_then(|id| l.conversation(id)) {
            Some(c) => ("chat", chat(ui, t, l, c)),
            None => ("no-chat", col().w_full().h_full().child(band()).children(notice(t, l)).child(no_chat(t, l).grow(1.0).min_h(0.0))),
        },
    };
    let swap = Transition::opacity().springs(motion::SWAP);
    row()
        .child(sidebar(ui, t, l))
        .child(col().key("main").grow(1.0).h_full().min_w(0.0).fill(t.paper).child(main.1.key(main.0).w_full().h_full().transition(swap)))
}

/// An empty titlebar band the window can be dragged by, above panes without a header.
fn band() -> El {
    row().key("band").w_full().h(TITLEBAR).window_drag()
}

fn sidebar(ui: &Ui, t: &Theme, l: &Linked) -> El {
    let list = if l.conversations.is_empty() {
        col().key("list-empty").px(space::S).child(text("No chats yet.").font(type_::SMALL).color(t.faint))
    } else {
        let rows = l.conversations.iter().fold(col().key("conversations").w_full().gap(2.0), |c, conv| c.child(conversation_row(ui, t, conv)));
        col().key("list").grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).scroll_edge_fade(12.0).child(rows)
    };
    let settings_open = ui.pane == Pane::Settings;
    let header = row()
        .key("sidebar-head")
        .h(TITLEBAR)
        .pl(t.band_lead(space::S))
        .items_center()
        .window_drag()
        .child(kit::logo(t))
        .child(spacer())
        .child(kit::icon_button(t, "open-settings", "Settings", kit::gear(if settings_open { t.ink } else { t.muted }, 16.0), |ui: &mut Ui, _| {
            ui.show(Pane::Settings)
        }));
    let (dot, status) = relay_status(t, l);
    let footer = row()
        .key("sidebar-foot")
        .h(48.0)
        .px(space::S)
        .gap(space::S)
        .items_center()
        .child(dot)
        .child(text(format!("@{}", l.account.handle)).font(type_::LABEL).color(t.ink).truncate().shrink())
        .child(spacer())
        .child(kit::caption(t, status));
    col()
        .key("sidebar")
        .w(SIDEBAR)
        .h_full()
        .px(space::M)
        .fill(t.paper)
        .child(header)
        .child(el().h(space::S))
        .child(new_chat_pill(ui, t))
        .child(el().h(space::XL))
        .child(kit::caption(t, "Chats").px(space::S).pb(space::S))
        .child(list.grow(1.0).min_h(0.0))
        .child(footer)
}

/// New chat as the site's search pill: a soft chip with its shortcut at the far end.
fn new_chat_pill(ui: &Ui, t: &Theme) -> El {
    let open = ui.pane == Pane::NewChat;
    let shortcut = if cfg!(target_os = "macos") { "⌘N" } else { "Ctrl N" };
    kit::surface(row().key("new-chat").role("button").label("New chat").w_full().h(36.0).px(space::M).center_y(), radius::CONTROL, t.chip)
        .hover(t.chip)
        .child(text("New chat").font(type_::SMALL).color(if open { t.ink } else { t.muted }).group_color(t.ink).a11y_hidden())
        .child(spacer())
        .child(text(shortcut).font(type_::CAPTION).color(t.faint).a11y_hidden())
        .hover_group()
        .focusable(true)
        .focus_ring(2.0, 2.0, t.brand)
        .cursor(Cursor::Pointer)
        .press_scale(0.98)
        .on_press(|ui: &mut Ui| ui.show(Pane::NewChat))
}

/// The account's link state as a dot and one word, for the sidebar footer.
fn relay_status(t: &Theme, l: &Linked) -> (El, &'static str) {
    use crate::model::RelayStatus::*;
    let (c, ring, word) = match (l.messaging, l.relay) {
        _ if l.trouble.is_some() => (t.link, true, "Unreachable"),
        (Messaging::Verifying, _) => (t.muted, true, "Verifying"),
        (_, Connecting) => (t.muted, true, "Connecting"),
        (_, Connected) => (t.brand, false, "Online"),
        (_, LocalOnly) => (t.muted, false, "Local only"),
        (_, Offline) => (t.link, true, "Offline"),
    };
    (kit::dot(c, ring), word)
}

/// A squircle initial; terracotta-tinted for the open conversation.
fn avatar(t: &Theme, peer: &str, size: f32, selected: bool) -> El {
    let initial = peer.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default();
    let (fill, ink) = if selected { (t.tint, t.link) } else { (t.chip, t.muted) };
    kit::surface(el().size(size, size).center(), size * 0.32, fill).child(text(initial).font(type_::LABEL).color(ink)).a11y_hidden()
}

fn conversation_row(ui: &Ui, t: &Theme, c: &Conversation) -> El {
    let selected = ui.pane == Pane::Chat && ui.selected.as_ref() == Some(&c.id);
    let unread = c.unread > 0;
    let preview = c.last().map_or(String::new(), |m| match m.direction {
        Direction::Received => m.text.clone(),
        Direction::Sent(_) => format!("You: {}", m.text),
    });
    let when = c.last().map_or(String::new(), |m| ago(m.at, ui.now));
    let id = c.id.clone();
    let mut meta = col().gap(space::XS).items_end().child(text(when).font(type_::CAPTION).color(t.faint));
    if unread {
        meta = meta.child(kit::badge(t, c.unread).key("unread").transition(Transition::scale(0.7).allow_small_scale().springs(motion::ARRIVE)));
    }
    // Rows read muted like the site's links and turn ink when open, hovered or unread.
    let (name, sub) = if selected || unread { (t.ink, t.muted) } else { (t.ink.alpha(0.82), t.faint) };
    let base = row().key(format!("c-{}", c.id.0)).h(56.0).px(space::S).gap(space::M).items_center();
    let base = kit::surface(base, radius::CONTROL, if selected { t.chip } else { Color::TRANSPARENT });
    let base = if selected { base } else { base.hover(t.hover) };
    base.child(avatar(t, &c.peer, 32.0, selected))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(2.0)
                .child(text(format!("@{}", c.peer)).font(if unread { type_::HEADING } else { type_::LABEL }).color(name).group_color(t.ink).truncate())
                .child(text(preview).font(type_::SMALL).color(sub).group_color(t.muted).truncate()),
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
    col().w_full().h_full().center().pb(TITLEBAR).child(
        col()
            .w(320.0)
            .gap(space::S)
            .items_center()
            .child(kit::mark(t, 44.0, false))
            .child(el().h(space::M))
            .child(text(title).font(type_::TITLE).color(t.ink))
            .child(text(sub).font(type_::BODY).color(t.muted).wrap().align(rune::Align::Center))
            .child(el().h(space::M))
            .child(kit::button(t, "empty-new-chat", "New chat", Kind::Primary, |ui: &mut Ui, _| ui.show(Pane::NewChat))),
    )
}

fn chat(ui: &Ui, t: &Theme, l: &Linked, c: &Conversation) -> El {
    let header = row()
        .key("chat-head")
        .h(TITLEBAR)
        .window_drag()
        .px(GUTTER)
        .gap(space::M)
        .items_center()
        .child(avatar(t, &c.peer, 28.0, false))
        .child(text(format!("@{}", c.peer)).font(type_::HEADING).color(t.ink));
    col().w_full().h_full().child(header).children(notice(t, l)).child(thread(t, c)).child(composer(ui, t))
}

/// One calm note under the header when messaging can't run normally: the chain unreachable,
/// membership being re-checked, or no network at all. Nothing is lost meanwhile; it says so.
fn notice(t: &Theme, l: &Linked) -> Option<El> {
    use crate::model::RelayStatus;
    let pulse = rune::Cycle { period: 1.2, phase: 0.0, stops: &[(0.0, 1.0), (0.5, 0.25), (1.0, 1.0)], still: 1.0, fps: 30.0 };
    // Trouble reads terracotta; a routine re-check stays a quiet ink chip.
    let (key, mark, fill, words) = if l.trouble.is_some() {
        ("unreachable", kit::dot(t.link, true), t.tint, "Can't reach the qop network. Messages wait here and go out once it's back.".to_owned())
    } else if l.messaging == Messaging::Verifying {
        ("verifying", kit::dot(t.brand, true).cycle(pulse), t.chip, format!("Re-checking this {}'s membership. Messages queue until it's done.", super::device()))
    } else if l.relay == RelayStatus::Offline {
        ("offline", kit::dot(t.link, true), t.tint, format!("This {} is offline. Messages wait here and go out once it reconnects.", super::device()))
    } else {
        return None;
    };
    Some(
        col().key(key).w_full().px(GUTTER - space::S).pb(space::S).transition(Transition::opacity().springs(motion::SWAP)).child(
            kit::surface(row().w_full().px(space::M).py(10.0).gap(space::M).items_center(), radius::CONTROL, fill)
                .child(mark)
                .child(text(words).font(type_::SMALL).color(t.ink).wrap().grow(1.0).min_w(0.0)),
        ),
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
        .px(GUTTER)
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
        .pt(space::S)
        .pb(space::XS)
        .scroll(ScrollSpec { stick_bottom: true })
        .scroll_edge_fade(20.0)
        .child(rows)
}

/// A labelled status mark for the meta line under a sent message.
fn status_word(key: &str, mark: El, word: &str, color: Color) -> El {
    row().key(key).gap(6.0).items_center().child(mark).child(text(word).font(type_::CAPTION).color(color))
}

fn message(ui: &Ui, t: &Theme, m: &Message, run_ends: bool, last_delivered: bool) -> El {
    let sent = matches!(m.direction, Direction::Sent(_));
    let fill = if sent { t.tint } else { t.element };
    let bubble = kit::surface(col().max_w(480.0).px(14.0).py(9.0), radius::CARD, fill)
        .child(text(m.text.clone()).font(type_::BODY).color(t.ink).wrap().selectable(true));
    let status = match m.direction {
        Direction::Sent(MessageStatus::Queued) => Some(status_word("queued", kit::dot(t.faint, true), "Queued", t.faint)),
        Direction::Sent(MessageStatus::Sent) if last_delivered => Some(status_word("delivered", kit::dot(t.faint, false), "Delivered", t.faint)),
        Direction::Sent(MessageStatus::Failed) => {
            let id = m.id.clone();
            Some(
                status_word("failed", kit::dot(t.link, false), "Not delivered", t.link)
                    .child(text("·").font(type_::CAPTION).color(t.faint))
                    .child(kit::link(t, &format!("retry-{}", m.id.0), "Retry", type_::CAPTION, move |ui: &mut Ui, _| ui.send(Command::Retry(id.clone())))),
            )
        }
        _ => None,
    };
    let mut body = col().gap(6.0).child(bubble);
    body = if sent { body.items_end() } else { body.items_start() };
    // The time closes a run of messages, or sits beside a status worth showing.
    if run_ends || status.is_some() {
        let mut meta = row().key("meta").px(space::XS).gap(space::S).items_center().child(text(ago(m.at, ui.now)).font(type_::CAPTION).color(t.faint));
        if let Some(s) = status {
            // Keyed by status, so a change crossfades in place.
            meta = meta.child(s.transition(Transition::opacity().springs(motion::SWAP)));
        }
        body = body.child(meta);
    }
    let pad_bottom = if run_ends { space::L } else { space::XS };
    let row = row().key(format!("m-{}", m.id.0)).w_full().pb(pad_bottom).child(body);
    let row = if sent { row.justify_end() } else { row.justify_start() };
    row.transition(Transition::offset(0.0, 14.0).combined(Transition::opacity()).springs(motion::ARRIVE))
}

/// The draft on a soft chip like `kit::Field`, ringed in terracotta while focused, with Send
/// tucked in at its trailing edge.
fn composer(ui: &Ui, t: &Theme) -> El {
    let input = text_input(&ui.composer, type_::BODY)
        .key("composer")
        .grow(1.0)
        .color(t.ink)
        .caret(t.brand, t.tint)
        .placeholder("Message", t.faint)
        .on_edit(|ui: &mut Ui| &mut ui.composer)
        .on_submit(|ui: &mut Ui, _| ui.send_message());
    // Grow with the draft up to eight lines, then scroll inside, so Send stays on screen.
    let input = auto_grow(input, 1, 8).key("composer-scroll");
    let ring = if ui.composer.focused { t.brand } else { Color::TRANSPARENT };
    let send_kind = if ui.composer.text.trim().is_empty() { Kind::Secondary } else { Kind::Primary };
    let field = kit::surface(row().key("composer-box").w_full().min_h(48.0).pl(space::L).pr(6.0).py(6.0).gap(space::S).items_end(), radius::CARD, t.chip)
        .border(1.0, ring)
        .child(col().grow(1.0).min_w(0.0).py(TEXT_INSET).child(input))
        .child(kit::button(t, "send", "Send", send_kind, |ui: &mut Ui, _| ui.send_message()).h(36.0));
    let bar = row().key("composer-bar").w_full().px(GUTTER - space::S).pt(space::XS).pb(space::L).child(field);
    // Over the limit: say so above the bar; the draft stays until it is short enough to send.
    let Some(error) = ui.composer_error() else { return bar };
    col()
        .w_full()
        .child(text(error).key("composer-error").font(type_::SMALL).color(t.link).px(GUTTER).pb(space::XS))
        .child(bar)
}

/// Vertical inset of the composer's text so one line sits centred beside the 36 pt Send button.
const TEXT_INSET: f32 = (36.0 - 20.0) / 2.0;

/// A pane's page, laid out like a qop.sh page: the title level with the sidebar's logo row (in
/// the titlebar band, so it drags the window), a muted lead, then the content.
fn page(t: &Theme, title: &str, lead: &str, content: El) -> El {
    col()
        .w_full()
        .px(GUTTER)
        .pb(space::XXL)
        .child(row().h(TITLEBAR).w_full().items_center().window_drag().child(text(title).font(type_::DISPLAY).color(t.ink)))
        .child(text(lead).font(type_::LEAD).color(t.muted).wrap())
        .child(el().h(space::XL + space::S))
        .child(content)
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
    let mut form = col().w_full().max_w(400.0).gap(space::S).child(field);
    if let Some((color, s)) = status {
        form = form.child(text(s).key("lookup").font(type_::SMALL).color(color).px(space::XS).transition(Transition::opacity().springs(motion::SWAP)));
    }
    let form = form.child(el().h(space::S)).child(
        row()
            .gap(space::S)
            .child(kit::button(t, "start-chat", "Start chat", Kind::Primary, |ui: &mut Ui, _| ui.start_chat()).default_button())
            .child(kit::button(t, "cancel-new-chat", "Cancel", Kind::Quiet, |ui: &mut Ui, _| ui.show(Pane::Chat))),
    );
    page(t, "New chat", "Message anyone on qop by their handle.", form)
}

fn settings(ui: &Ui, t: &Theme, l: &Linked) -> El {
    let a = &l.account;
    let peer = a.peer_id.clone();
    let section = |title: &str, rows: Vec<(&str, El)>| {
        let card = rows.into_iter().fold(kit::card(t, col().px(space::L).py(6.0)), |card, (label, value)| {
            card.child(row().h(40.0).gap(space::L).items_center().child(text(label).font(type_::SMALL).color(t.muted).w(120.0)).child(value))
        });
        col().gap(space::S).child(kit::caption(t, title).px(space::XS)).child(card)
    };
    let value = |s: String| text(s).font(type_::BODY).color(t.ink).truncate_middle().grow(1.0).min_w(0.0);
    let (dot, state) = match (l.messaging, l.trouble) {
        (_, Some(_)) => (kit::dot(t.link, true), "Linked · can't reach the network"),
        (Messaging::Ready, None) => (kit::dot(t.brand, false), "Linked"),
        (Messaging::Verifying, None) => (kit::dot(t.muted, true), "Linked · re-checking membership"),
    };
    let linked_state = row().gap(space::S).items_center().child(dot).child(text(state).font(type_::BODY).color(t.ink));
    let unlink = if ui.confirm_unlink {
        col()
            .key("unlink-confirm")
            .gap(space::M)
            .child(text(format!("Unlink @{} from this {}?", a.handle, super::device())).font(type_::BODY).color(t.ink).wrap())
            .child(
                row()
                    .gap(space::S)
                    .child(kit::button(t, "unlink-yes", &format!("Unlink @{}", a.handle), Kind::Danger, |ui: &mut Ui, _| ui.send(Command::Unlink)))
                    .child(kit::button(t, "unlink-no", "Keep linked", Kind::Quiet, |ui: &mut Ui, _| ui.confirm_unlink = false)),
            )
    } else {
        row().key("unlink-ask").child(kit::button(t, "unlink", &format!("Unlink this {}", super::device()), Kind::Danger, |ui: &mut Ui, _| ui.confirm_unlink = true))
    };
    let body = col()
        .w_full()
        .max_w(620.0)
        .gap(space::XL)
        .child(section("Account", vec![("Handle", value(format!("@{}", a.handle))), ("Link state", linked_state)]))
        .child(section(
            &format!("This {}", super::device()),
            vec![
                (
                    "Peer ID",
                    row()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(space::M)
                        .items_center()
                        .child(value(a.peer_id.clone()))
                        .child(kit::link(t, "copy-peer", "Copy", type_::SMALL, move |_: &mut Ui, tx| tx.copy(peer.clone()))),
                ),
                ("Fingerprint", row().child(kit::chip(t, kit::group(&a.fingerprint)))),
                ("Relay", relay_line(t, l.relay)),
                ("Data", value(a.data_dir.display().to_string())),
            ],
        ))
        .child(
            col().gap(space::S).child(kit::caption(t, "Unlink").px(space::XS)).child(
                kit::card(t, col().padding(space::L).gap(space::L))
                    .child(
                        text(format!("Signs this {} out and erases its key and messages here. Also remove it on your phone under Profile → Devices.", super::device()))
                            .font(type_::SMALL)
                            .color(t.muted)
                            .wrap(),
                    )
                    .child(unlink.transition(Transition::opacity().springs(motion::SWAP))),
            ),
        );
    col()
        .key("settings-scroll")
        .w_full()
        .h_full()
        .scroll(ScrollSpec { stick_bottom: false })
        .scroll_edge_fade(16.0)
        .child(page(t, "Settings", &format!("Your account and this {}'s link to it.", super::device()), body))
}
