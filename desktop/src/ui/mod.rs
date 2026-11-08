//! The Rune UI. `Ui` is the app state: the engine's latest [`Model`] plus state only the UI owns
//! (field text, the open conversation and pane). The engine publishes with
//! `AppHandle<Ui>::update(|ui, _| ui.publish(model))`; the UI sends [`Command`]s back over the
//! channel `Ui::new` takes.

pub mod fake;
mod kit;
mod linked;
mod onboard;
pub mod theme;

use std::sync::mpsc::Sender;
use std::time::{Duration, SystemTime};

use rune::{Cx, El, Key, KeyEvent, TextEdit, Transition, Tx, col};

use crate::model::{Command, ConversationId, Model, NewChat, Phase};
use qop_desktop::wire::chat::{ChatError, ChatFrame, MAX_TEXT_UNITS};
use theme::{Theme, motion};

/// Which pane fills the main area while linked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pane {
    Chat,
    NewChat,
    Settings,
}

/// The app state Rune renders.
pub struct Ui {
    /// The engine's latest model; change it only through [`Ui::update_model`].
    model: Model,
    commands: Sender<Command>,
    pub handle_field: TextEdit,
    pub composer: TextEdit,
    pub new_chat_field: TextEdit,
    /// The open conversation, if it still exists.
    pub selected: Option<ConversationId>,
    pub pane: Pane,
    /// Settings asked "Unlink?" and waits for the second click.
    pub confirm_unlink: bool,
    /// The conversation and length an earlier page was last asked for, so scrolling at the top
    /// asks once per page.
    asked_earlier: Option<(ConversationId, usize)>,
    /// Wall time for countdowns and relative times, refreshed by `poll`.
    pub now: SystemTime,
    /// Rune's clock (virtual when headless) at the last `poll`.
    clock: f64,
    /// When Copy code was pressed, on Rune's clock; the button says Copied for a moment.
    copied_at: Option<f64>,
    qr: kit::QrCache,
}

/// How long the Copy button says Copied.
const COPIED_FOR: f64 = 1.6;

impl Ui {
    pub fn new(commands: Sender<Command>) -> Ui {
        Ui {
            model: Model::STARTING,
            commands,
            handle_field: TextEdit::new(""),
            composer: TextEdit::new(""),
            new_chat_field: TextEdit::new(""),
            selected: None,
            pane: Pane::Chat,
            confirm_unlink: false,
            asked_earlier: None,
            now: SystemTime::now(),
            clock: 0.0,
            copied_at: None,
            qr: kit::QrCache::default(),
        }
    }

    /// Replaces the model; the engine's usual entry point.
    pub fn publish(&mut self, model: Model) {
        self.update_model(|m| *m = model);
    }

    /// Changes the model in place, then brings UI-local state in line with it.
    pub fn update_model(&mut self, change: impl FnOnce(&mut Model)) {
        change(&mut self.model);
        let Phase::Linked(linked) = &self.model.phase else {
            self.selected = None;
            self.pane = Pane::Chat;
            self.confirm_unlink = false;
            return;
        };
        if self.selected.as_ref().is_some_and(|id| linked.conversation(id).is_none()) {
            self.selected = None;
        }
        // A lookup for the handle still in the New chat field resolved: open its chat once.
        if let NewChat::Resolved { handle, conversation } = &linked.new_chat
            && self.pane == Pane::NewChat
            && normalize_handle(&self.new_chat_field.text) == *handle
        {
            let id = conversation.clone();
            self.new_chat_field.clear();
            self.open(id);
        }
    }

    fn send(&self, command: Command) {
        // The engine owns the receiver; if it has gone, there's nothing left to tell.
        let _ = self.commands.send(command);
    }

    /// Opens a conversation and tells the engine it was read. A draft belongs to the chat it was
    /// typed in, so opening another clears it.
    pub fn open(&mut self, id: ConversationId) {
        if self.selected.as_ref() != Some(&id) {
            self.composer.clear();
        }
        self.selected = Some(id.clone());
        self.pane = Pane::Chat;
        self.send(Command::OpenConversation(id));
    }

    /// The open conversation's messages.
    fn thread(&self) -> Option<&[crate::model::Message]> {
        let Phase::Linked(linked) = &self.model.phase else { return None };
        Some(&linked.conversation(self.selected.as_ref()?)?.messages)
    }

    /// Asks for the page before the `shown` messages of `id`, once.
    fn load_earlier(&mut self, id: &ConversationId, shown: usize) {
        let ask = (id.clone(), shown);
        if self.asked_earlier.as_ref() != Some(&ask) {
            self.asked_earlier = Some(ask);
            self.send(Command::LoadEarlier(id.clone()));
        }
    }

    fn submit_handle(&mut self) {
        let handle = normalize_handle(&self.handle_field.text);
        if !handle.is_empty() {
            self.send(Command::SubmitHandle(handle));
        }
    }

    fn start_chat(&mut self) {
        let handle = normalize_handle(&self.new_chat_field.text);
        if !handle.is_empty() {
            self.send(Command::StartChat(handle));
        }
    }

    /// Why the engine would refuse the draft, if it would; Send then keeps it. Text within the
    /// character limit can still overflow the encoded frame (JSON escapes control characters
    /// sixfold), so this encodes the frame the engine will send.
    pub fn composer_error(&self) -> Option<String> {
        let text = self.composer.text.trim();
        let units = text.encode_utf16().count();
        if units > MAX_TEXT_UNITS {
            return Some(format!("Too long to send: {units} of {MAX_TEXT_UNITS} characters"));
        }
        let Phase::Linked(linked) = &self.model.phase else { return None };
        let frame = ChatFrame {
            from_handle: linked.account.handle.clone(),
            // Same length as the engine's id and timestamp, so the same size.
            id: "00000000-0000-4000-8000-000000000000".into(),
            sent_at: self.now.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
            text: text.to_owned(),
        };
        (frame.encode() == Err(ChatError::Oversized)).then(|| "Too long to send".to_owned())
    }

    fn send_message(&mut self) {
        let text = self.composer.text.trim().to_owned();
        let Some(conversation) = self.selected.clone() else { return };
        if text.is_empty() || self.composer_error().is_some() {
            return;
        }
        self.send(Command::Send { conversation, text });
        self.composer.clear();
    }

    fn copy_offer(&mut self, code: String, tx: &mut Tx) {
        tx.copy(code);
        self.copied_at = Some(self.clock);
        tx.wake_after(Duration::from_secs_f64(COPIED_FOR));
    }

    fn copied(&self) -> bool {
        self.copied_at.is_some_and(|at| self.clock - at < COPIED_FOR)
    }

    /// Whether a ticking countdown is on screen, so `poll` refreshes `now` every second.
    fn counting_down(&self) -> bool {
        match &self.model.phase {
            Phase::Pairing(p) => p.offer.is_some(),
            Phase::AwaitingEnrollment(a) => a.recovery.is_some(),
            _ => false,
        }
    }
}

/// A handle as typed, without spaces or a leading `@`.
pub fn normalize_handle(s: &str) -> String {
    s.trim().trim_start_matches('@').to_lowercase()
}

/// Root view: the current phase's screen, crossfading and lifting in when the phase changes.
pub fn view(ui: &Ui, cx: &mut Cx<Ui>) -> El {
    let t = Theme::new(cx.system_dark());
    let (key, screen) = match &ui.model.phase {
        Phase::Starting => ("starting", onboard::starting(&t)),
        Phase::EnterHandle(e) => ("enter-handle", onboard::enter_handle(ui, &t, e)),
        Phase::Pairing(p) => ("pairing", onboard::pairing(ui, &t, &p.handle, p.offer.as_ref(), p.relay, false)),
        Phase::AwaitingEnrollment(a) => match &a.recovery {
            Some(offer) => ("recovery", onboard::pairing(ui, &t, &a.handle, Some(offer), a.relay, true)),
            None => ("awaiting", onboard::awaiting(&t, a)),
        },
        Phase::Linked(l) => ("linked", linked::linked(ui, &t, l)),
        Phase::Revoked(r) => ("revoked", onboard::revoked(&t, r)),
    };
    let enter = Transition::offset(0.0, 10.0).combined(Transition::opacity()).springs(motion::SCREEN);
    col().key("root").w_full().h_full().fill(t.paper).child(screen.key(key).w_full().h_full().transition(enter))
}

/// Refreshes the clock-driven bits: countdowns each second, relative times each half minute, and
/// the Copied label's timeout. True only when something visible changed.
pub fn poll(ui: &mut Ui, clock: f64, tx: &mut Tx) -> bool {
    ui.clock = clock;
    let mut changed = false;
    if ui.copied_at.is_some() && !ui.copied() {
        ui.copied_at = None;
        changed = true;
    }
    let now = SystemTime::now();
    let step = if ui.counting_down() { 1 } else { 30 };
    let secs = |t: SystemTime| t.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_secs()) / step;
    if secs(now) != secs(ui.now) {
        ui.now = now;
        changed = true;
    }
    let into = now.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.subsec_millis());
    tx.wake_after(Duration::from_millis(u64::from(1000 - into)) + Duration::from_secs(step - 1));
    changed
}

/// ⌘N opens New chat, ⌘, opens Settings, Escape goes back to the chat.
pub fn on_key(ui: &mut Ui, ev: &KeyEvent, _: &mut Tx) -> bool {
    if !matches!(ui.model.phase, Phase::Linked(_)) {
        return false;
    }
    ui.pane = match ev.key {
        Key::Command('n') => Pane::NewChat,
        Key::Command(',') => Pane::Settings,
        Key::Escape if ui.pane != Pane::Chat => Pane::Chat,
        _ => return false,
    };
    ui.confirm_unlink = false;
    true
}

/// `4:32` for a countdown.
fn countdown(left: Duration) -> String {
    let s = left.as_secs();
    format!("{}:{:02}", s / 60, s % 60)
}

/// `now`, `5m`, `3h` or `2d` since `at`.
fn ago(at: SystemTime, now: SystemTime) -> String {
    let s = now.duration_since(at).map_or(0, |d| d.as_secs());
    match s {
        0..60 => "now".into(),
        60..3600 => format!("{}m", s / 60),
        3600..86_400 => format!("{}h", s / 3600),
        _ => format!("{}d", s / 86_400),
    }
}

#[cfg(test)]
mod tests;
