//! Screens before the device is linked: starting, handle entry, pairing, waiting, and revoked.

use std::time::Duration;

use rune::{Edge, El, Transition, col, el, row, spacer, text};

use super::kit::{self, Field, Kind, Notch, notched};
use super::theme::{Theme, motion, space, type_};
use super::{Ui, countdown};
use crate::model::{
    AwaitingEnrollment, Command, EnrollmentProgress, EnterHandle, HandleLookup, LookupError, Offer, RelayStatus, Revoked,
    Unreachable,
};

/// A screen-filling column that centres `content`, with the wordmark in the corner.
fn page(t: &Theme, content: El) -> El {
    col()
        .w_full()
        .h_full()
        .padding(space::XL)
        .child(row().child(kit::wordmark(t.ink, 14.0)))
        .child(col().grow(1.0).min_h(0.0).center().child(content))
}

pub fn starting(t: &Theme) -> El {
    col()
        .w_full()
        .h_full()
        .center()
        .gap(space::L)
        .child(kit::mark(t, 48.0, true))
        .child(text("Opening qop").font(type_::SMALL).color(t.muted))
}

pub fn enter_handle(ui: &Ui, t: &Theme, e: &EnterHandle) -> El {
    let resolving = matches!(e.lookup, HandleLookup::Resolving { .. });
    let error = match &e.lookup {
        HandleLookup::Failed { handle, error } => Some(lookup_error(handle, *error)),
        _ => None,
    };
    let field = Field { key: "handle", edit: &ui.handle_field, placeholder: "yourname", prefix: Some("@") }
        .build(t, |ui: &mut Ui| &mut ui.handle_field, |ui: &mut Ui, _| ui.submit_handle());
    let label = if resolving { "Looking up…" } else { "Continue" };
    let mut form = col()
        .w(380.0)
        .gap(space::S)
        .child(kit::mark(t, 44.0, resolving))
        .child(el().h(space::L))
        .child(text("Link this Mac").font(type_::DISPLAY).color(t.ink))
        .child(
            text("qop Desktop joins your account as a linked device, approved from your phone.")
                .font(type_::BODY)
                .color(t.muted)
                .wrap(),
        )
        .child(el().h(space::L))
        .child(kit::caption(t, "Your handle"))
        .child(field);
    if let Some(error) = error {
        form = form.child(text(error).key("handle-error").font(type_::SMALL).color(t.link).transition(Transition::opacity().springs(motion::SWAP)));
    }
    page(
        t,
        form.child(el().h(space::S))
            .child(row().child(kit::button(t, "continue", label, Kind::Primary, |ui: &mut Ui, _| ui.submit_handle()).default_button()))
            .child(el().h(space::XL))
            .child(text("New to qop? Create your account in the qop app on your phone first.").font(type_::SMALL).color(t.muted).wrap()),
    )
}

fn lookup_error(handle: &str, error: LookupError) -> String {
    match error {
        LookupError::Invalid => "Handles use letters, numbers and underscores.".into(),
        LookupError::NotFound => format!("No account is called @{handle}."),
        LookupError::Unreachable => "Couldn't reach the network. Try again in a moment.".into(),
    }
}

/// The pairing screen: steps on the left, the QR card on the right. `recovering` is the same
/// screen after Stop waiting, which offers the code again but cannot unlink.
pub fn pairing(ui: &Ui, t: &Theme, handle: &str, offer: Option<&Offer>, relay: RelayStatus, recovering: bool) -> El {
    let (title, sub) = if recovering {
        (format!("Finish linking @{handle}"), "Linking continues in the background. If your phone didn't finish, scan this code again.")
    } else {
        (format!("Scan to link @{handle}"), "Approve this Mac from your phone. It never sees your account key.")
    };
    let steps = [
        "Open qop on your phone",
        "Go to Profile → Devices → Link device",
        "Scan this code and approve",
    ];
    let mut left = col()
        .w(340.0)
        .gap(space::S)
        .child(text(title).font(type_::DISPLAY).color(t.ink).wrap())
        .child(text(sub).font(type_::BODY).color(t.muted).wrap())
        .child(el().h(space::L))
        .child(steps.iter().enumerate().fold(col().gap(space::M), |c, (i, s)| c.child(step(t, i + 1, s))))
        .child(el().h(space::XL))
        .child(relay_line(t, relay));
    if !recovering {
        left = left.child(el().h(space::XS)).child(kit::link(t, "unlink", &format!("Not @{handle}? Use another handle"), |ui: &mut Ui, _| ui.send(Command::Unlink)));
    }
    page(t, row().gap(56.0).items_center().child(left).child(qr_card(ui, t, offer, relay)))
}

/// One numbered instruction.
fn step(t: &Theme, n: usize, s: &str) -> El {
    row()
        .gap(space::M)
        .items_center()
        .child(notched(el().size(24.0, 24.0).center(), Notch::Small, t.element, None).child(text(n.to_string()).font(type_::CAPTION).color(t.ink)))
        .child(text(s).font(type_::BODY).color(t.ink).grow(1.0).wrap())
}

/// A status mark and word for the relay.
pub fn relay_line(t: &Theme, relay: RelayStatus) -> El {
    let (color, ring, word) = match relay {
        RelayStatus::Connecting => (t.muted, true, "Connecting to a relay"),
        RelayStatus::Connected => (t.brand, false, "Relay connected"),
        RelayStatus::LocalOnly => (t.muted, false, "Local network only"),
        RelayStatus::Offline => (t.link, true, "Offline"),
    };
    row().gap(space::S).items_center().child(kit::dot(color, ring)).child(text(word).font(type_::SMALL).color(t.muted))
}

/// The QR on a foam tile in a card with a hard offset shadow, plus countdown and actions.
fn qr_card(ui: &Ui, t: &Theme, offer: Option<&Offer>, relay: RelayStatus) -> El {
    const TILE: f32 = 244.0;
    let left = offer.map(|o| o.expires_at.duration_since(ui.now).unwrap_or(Duration::ZERO));
    let expired = left == Some(Duration::ZERO);
    let tile = notched(el().key("qr-tile").size(TILE, TILE).center(), Notch::Large, t.foam, None);
    let tile = match offer {
        None => tile.child(
            col().key("qr-waiting").gap(space::M).center().child(kit::mark(t, 36.0, true)).child(
                text(if relay == RelayStatus::Offline { "Waiting for a network" } else { "Reserving a relay" })
                    .font(type_::SMALL)
                    .color(t.on_foam.alpha(0.6)),
            ),
        ),
        // Keyed by payload, so Regenerate prints the new code in with a top-down wipe.
        Some(o) => tile.child(
            ui.qr
                .view(&o.code, TILE - 32.0, t.on_foam, t.foam)
                .key(o.code.as_str())
                .opacity(if expired { 0.1 } else { 1.0 })
                .transition(Transition::reveal(Edge::Top).combined(Transition::opacity()).springs(motion::SCREEN)),
        ),
    };
    let tile = if expired {
        tile.child(
            col().key("qr-expired").absolute(0.0, 0.0).size(TILE, TILE).center().gap(space::M)
                .child(text("Code expired").font(type_::HEADING).color(t.on_foam))
                .transition(Transition::scale(0.96).springs(motion::SWAP)),
        )
    } else {
        tile
    };
    let fraction = left.map_or(1.0, |l| l.as_secs_f32() / crate::model::PAIRING_TTL.as_secs_f32());
    let timer = row()
        .key("timer")
        .gap(space::M)
        .items_center()
        .child(kit::blocks(t, "ttl", if offer.is_some() { fraction } else { 0.0 }, 16))
        .child(spacer())
        .child(
            text(match left {
                None => "--:--".to_owned(),
                Some(Duration::ZERO) => "Expired".to_owned(),
                Some(l) => format!("Expires in {}", countdown(l)),
            })
            .font(type_::DIGITS)
            .color(if expired { t.link } else { t.muted }),
        );
    let copy_label = if ui.copied() { "Copied" } else { "Copy code" };
    let actions = match offer {
        Some(o) if !expired => {
            let code = o.code.clone();
            row()
                .gap(space::S)
                .child(kit::button(t, "copy", copy_label, Kind::Secondary, move |ui: &mut Ui, tx| ui.copy_offer(code.clone(), tx)))
                .child(kit::button(t, "regenerate", "New code", Kind::Quiet, |ui: &mut Ui, _| ui.send(Command::RegeneratePairing)))
        }
        Some(_) => row().child(kit::button(t, "regenerate", "New code", Kind::Primary, |ui: &mut Ui, _| ui.send(Command::RegeneratePairing))),
        None => text("The code appears here once this Mac is reachable.").font(type_::SMALL).color(t.muted).wrap().h(36.0),
    };
    let fingerprint = offer.map_or(row().h(20.0), |o| {
        row().gap(space::S).items_center().child(kit::caption(t, "Fingerprint")).child(spacer()).child(kit::chip(t, kit::group(&o.fingerprint)))
    });
    let card = kit::card(t, col().key("qr-card").w(TILE + 2.0 * space::L).padding(space::L).gap(space::M))
        .child(tile)
        .child(timer)
        .child(actions)
        .child(fingerprint);
    // A hard, offset "print" shadow in the border colour.
    el().child(notched(el().pin(Some(5.0), Some(5.0), Some(-5.0), Some(-5.0)), Notch::Large, t.border, None)).child(card)
}

pub fn awaiting(t: &Theme, a: &AwaitingEnrollment) -> El {
    let steps = [
        (EnrollmentProgress::Approved, "Approved on your phone"),
        (EnrollmentProgress::Submitted, "Submitted to the network"),
        (EnrollmentProgress::Confirming, "Confirmed on chain"),
    ];
    let list = steps.iter().fold(col().gap(space::M), |c, &(stage, label)| {
        // Stages up to the current one are done; the next is in progress.
        let done = stage <= a.progress;
        let current = !done && steps.iter().find(|(s, _)| *s > a.progress).is_some_and(|(s, _)| *s == stage);
        let mark = if done {
            kit::dot(t.brand, false)
        } else if current {
            kit::dot(t.brand, true).cycle(rune::Cycle { period: 1.2, phase: 0.0, stops: &[(0.0, 1.0), (0.5, 0.25), (1.0, 1.0)], still: 1.0, fps: 30.0 })
        } else {
            kit::dot(t.border, true)
        };
        c.child(
            row()
                .key(label)
                .gap(space::M)
                .items_center()
                .child(mark.key("mark").transition(Transition::scale(0.6).allow_small_scale().springs(motion::ARRIVE)))
                .child(text(label).font(type_::BODY).color(if done || current { t.ink } else { t.muted })),
        )
    });
    page(
        t,
        col()
            .w(400.0)
            .gap(space::S)
            .child(kit::mark(t, 44.0, true))
            .child(el().h(space::L))
            .child(text("Waiting for confirmation").font(type_::DISPLAY).color(t.ink))
            .child(
                text(format!("Your phone approved this Mac for @{}. It joins the account once the network confirms it, usually within a minute.", a.handle))
                    .font(type_::BODY)
                    .color(t.muted)
                    .wrap(),
            )
            .child(el().h(space::L))
            .child(kit::card(t, col().padding(space::L)).child(list))
            .children(a.trouble.map(|trouble| {
                let words = match trouble {
                    Unreachable::Chain => "Can't reach the network right now. Your approval is saved here; this keeps checking.",
                    Unreachable::Api => "Can't reach the qop server right now. Your approval is saved here; this keeps checking.",
                };
                // Top-aligned: the dot sits on the first line of the wrapped text.
                row()
                    .key("trouble")
                    .pt(space::M)
                    .gap(space::S)
                    .items_start()
                    .child(kit::dot(t.link, true).mt(5.0))
                    .child(text(words).font(type_::SMALL).color(t.muted).wrap().grow(1.0).min_w(0.0))
                    .transition(Transition::opacity().springs(motion::SWAP))
            }))
            .child(el().h(space::L))
            .child(row().child(kit::button(t, "stop-waiting", "Stop waiting", Kind::Secondary, |ui: &mut Ui, _| ui.send(Command::StopWaiting)))),
    )
}

pub fn revoked(t: &Theme, r: &Revoked) -> El {
    page(
        t,
        col()
            .w(400.0)
            .gap(space::S)
            .child(kit::mark(&Theme { brand: t.border, mark_tile: t.element, ..*t }, 44.0, false))
            .child(el().h(space::L))
            .child(text("This Mac was unlinked").font(type_::DISPLAY).color(t.ink))
            .child(
                text(format!(
                    "It was removed from @{} on your phone, so its key and the messages stored here have been erased. Start over to link it again; it gets a new key.",
                    r.handle
                ))
                    .font(type_::BODY)
                    .color(t.muted)
                    .wrap(),
            )
            .child(el().h(space::L))
            .child(row().child(kit::button(t, "start-over", "Start over", Kind::Primary, |ui: &mut Ui, _| ui.send(Command::AcknowledgeRevoked)).default_button())),
    )
}
