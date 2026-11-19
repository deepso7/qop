//! Screens before the device is linked: starting, handle entry, pairing, waiting, and revoked.
//! Laid out like qop.sh's docs: a left-aligned column with a big Inter headline over a muted lead,
//! numbered steps on small terracotta circles, and soft squircle panels.

use std::time::Duration;

use rune::{Cycle, Edge, El, Shape, Transition, canvas, col, el, row, spacer, text};

use super::kit::{self, Field, Kind};
use super::theme::{TITLEBAR, Theme, motion, radius, space, type_};
use super::{Ui, countdown, normalize_handle};
use crate::model::{
    AwaitingEnrollment, Command, EnrollmentProgress, EnterHandle, HandleLookup, LookupError, Offer, RelayStatus, Revoked,
    Unreachable,
};

/// Width of the single-column screens' content.
const COLUMN: f32 = 400.0;

/// A screen-filling column that centres `content`, with the wordmark in the corner.
fn page(t: &Theme, content: El) -> El {
    col()
        .w_full()
        .h_full()
        .px(space::XL)
        .pb(space::XL)
        // The titlebar band: the wordmark sits past the traffic lights, and the band drags the window.
        .child(row().h(TITLEBAR).ml(t.band_lead(space::XL) - space::XL).items_center().window_drag().child(kit::logo(t)))
        .child(col().grow(1.0).min_h(0.0).center().child(content))
}

/// A screen's headline and the muted lead paragraph under it, as at the top of a qop.sh page.
fn intro(t: &Theme, title: impl Into<String>, lead: impl Into<String>) -> El {
    col()
        .gap(space::S)
        .child(text(title).font(type_::DISPLAY).color(t.ink).wrap())
        .child(text(lead).font(type_::LEAD).color(t.muted).wrap())
}

pub fn starting(t: &Theme) -> El {
    // No header here, so the whole screen drags the window.
    col()
        .w_full()
        .h_full()
        .window_drag()
        .center()
        .gap(space::L)
        .child(kit::mark(t, 48.0, true))
        .child(kit::caption(t, "Opening qop"))
}

pub fn enter_handle(ui: &Ui, t: &Theme, e: &EnterHandle) -> El {
    let resolving = matches!(e.lookup, HandleLookup::Resolving { .. });
    // Only for the handle still in the field, as New chat does: an edit hides a stale failure.
    let error = match &e.lookup {
        HandleLookup::Failed { handle, error } if *handle == normalize_handle(&ui.handle_field.text) => {
            Some(lookup_error(handle, *error))
        }
        _ => None,
    };
    let field = Field { key: "handle", edit: &ui.handle_field, placeholder: "yourname", prefix: Some("@") }
        .build(t, |ui: &mut Ui| &mut ui.handle_field, |ui: &mut Ui, _| ui.submit_handle());
    let label = if resolving { "Looking up…" } else { "Continue" };
    let mut form = col().gap(space::S).child(kit::caption(t, "Your handle")).child(field);
    if let Some(error) = error {
        form = form.child(text(error).key("handle-error").font(type_::SMALL).color(t.link).wrap().transition(Transition::opacity().springs(motion::SWAP)));
    }
    page(
        t,
        col()
            .w(COLUMN)
            .child(kit::mark(t, 40.0, resolving))
            .child(el().h(space::XL))
            .child(intro(t, format!("Link this {}", super::device()), "qop Desktop joins your account as a linked device, approved from your phone."))
            .child(el().h(space::XXL - space::S))
            .child(form)
            .child(el().h(space::L))
            .child(row().child(kit::button(t, "continue", label, Kind::Primary, |ui: &mut Ui, _| ui.submit_handle()).default_button()))
            .child(el().h(space::XXL))
            .child(
                kit::surface(col().padding(space::L).gap(space::XS), radius::CARD, t.chip)
                    .child(kit::caption(t, "New to qop?"))
                    .child(text("Create your account in the qop app on your phone first.").font(type_::SMALL).color(t.muted).wrap()),
            ),
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
        (format!("Finish linking @{handle}"), "Linking continues in the background. If your phone didn't finish, scan this code again.".to_owned())
    } else {
        (format!("Scan to link @{handle}"), format!("Approve this {} from your phone. It never sees your account key.", super::device()))
    };
    let steps = ["Open qop on your phone", "Go to Profile → Devices → Link device", "Scan this code and approve"];
    let list = steps.iter().enumerate().fold(col(), |c, (i, s)| {
        let marker = step_circle(t.link).child(text((i + 1).to_string()).font(type_::LABEL).color(t.paper));
        // The circle is hidden from screen readers, so the number goes in the step's value.
        c.child(step(t, marker, i + 1 == steps.len(), text(*s).font(type_::BODY).color(t.ink).a11y_value(format!("{}. {s}", i + 1))))
    });
    let mut left = col()
        .w(340.0)
        .child(intro(t, title, sub))
        .child(el().h(space::XL + space::S))
        .child(list)
        .child(el().h(space::XL + space::S))
        .child(relay_line(t, relay));
    if !recovering {
        left = left.child(el().h(space::M)).child(kit::link(t, "unlink", &format!("Not @{handle}? Use another handle"), |ui: &mut Ui, _| ui.send(Command::Unlink)));
    }
    page(t, row().gap(56.0).items_center().child(left).child(qr_card(ui, t, offer, relay)))
}

/// A 22 pt circle for a step's number or state, filled with `fill`.
fn step_circle(fill: rune::Color) -> El {
    el().size(22.0, 22.0).radius(11.0).fill(fill).center().a11y_hidden()
}

/// One step of a numbered list, as on qop.sh's docs: `marker` on the left, joined to the next
/// step by a hairline unless `last`, and `label` beside it.
fn step(t: &Theme, marker: El, last: bool, label: El) -> El {
    let rail = col().w(22.0).items_center().child(marker);
    let rail = if last { rail } else { rail.child(el().w(1.0).grow(1.0).min_h(space::S).my(space::XS).fill(t.border)) };
    row().gap(space::M).items_stretch().child(rail).child(label.pt(1.0).pb(if last { 0.0 } else { space::L + space::XS }).grow(1.0).min_w(0.0).wrap())
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

/// The QR on a pale tile (light in both themes, so phones scan it) inside a soft panel, with the
/// countdown, actions and fingerprint below it.
fn qr_card(ui: &Ui, t: &Theme, offer: Option<&Offer>, relay: RelayStatus) -> El {
    const TILE: f32 = 236.0;
    let left = offer.map(|o| o.expires_at.duration_since(ui.now).unwrap_or(Duration::ZERO));
    let expired = left == Some(Duration::ZERO);
    let tile = kit::surface(el().key("qr-tile").size(TILE, TILE).center(), radius::CARD, t.qr_light);
    let tile = match offer {
        None => tile.child(
            col().key("qr-waiting").gap(space::M).center().child(kit::mark(t, 36.0, true)).child(
                text(if relay == RelayStatus::Offline { "Waiting for a network" } else { "Reserving a relay" })
                    .font(type_::SMALL)
                    .color(t.qr_dark.alpha(0.6)),
            ),
        ),
        // Keyed by payload, so Regenerate prints the new code in with a top-down wipe.
        Some(o) => tile.child(
            ui.qr
                .view(&o.code, TILE - 28.0, t.qr_dark, t.qr_light)
                .key(o.code.as_str())
                .opacity(if expired { 0.08 } else { 1.0 })
                .transition(Transition::reveal(Edge::Top).combined(Transition::opacity()).springs(motion::SCREEN)),
        ),
    };
    let tile = if expired {
        tile.child(
            col()
                .key("qr-expired")
                .absolute(0.0, 0.0)
                .size(TILE, TILE)
                .center()
                .gap(space::XS)
                .child(text("Code expired").font(type_::HEADING).color(t.qr_dark))
                .child(text("Make a new one to keep linking.").font(type_::SMALL).color(t.qr_dark.alpha(0.6)))
                .transition(Transition::scale(0.96).springs(motion::SWAP)),
        )
    } else {
        tile
    };
    let fraction = left.map_or(1.0, |l| l.as_secs_f32() / crate::model::PAIRING_TTL.as_secs_f32());
    // The label and time share a line above the bar, so neither crowds the card's edge.
    let (word, time) = match left {
        None => ("Expires in", "--:--".to_owned()),
        Some(Duration::ZERO) => ("Expired", "0:00".to_owned()),
        Some(l) => ("Expires in", countdown(l)),
    };
    let timer = col()
        .key("timer")
        .gap(space::S)
        .child(
            row()
                .items_center()
                .child(kit::caption(t, word))
                .child(spacer())
                .child(text(time).font(type_::DIGITS).color(if expired { t.link } else { t.ink })),
        )
        .child(kit::progress(t, "ttl", if offer.is_some() { fraction } else { 0.0 }));
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
        None => text(format!("The code appears here once this {} is reachable.", super::device())).font(type_::SMALL).color(t.muted).wrap().h(34.0),
    };
    let fingerprint = offer.map_or(row().h(22.0), |o| {
        row().gap(space::S).items_center().child(kit::caption(t, "Fingerprint")).child(spacer()).child(kit::chip(t, kit::group(&o.fingerprint)))
    });
    kit::card(t, col().key("qr-card").w(TILE + 2.0 * space::S).padding(space::S).pb(space::L))
        .child(tile)
        .child(col().px(space::S).pt(space::L).gap(space::L).child(timer).child(actions).child(fingerprint))
}

/// A tick, `size` points square, stroked in `color`.
fn check(color: rune::Color, size: f32) -> El {
    canvas(Shape::new().stroke(vec![[5.0, 12.5], [10.0, 17.0], [19.0, 7.5]], 2.4, color).view_box(24.0, 24.0)).size(size, size)
}

pub fn awaiting(t: &Theme, a: &AwaitingEnrollment) -> El {
    let steps = [
        (EnrollmentProgress::Approved, "Approved on your phone"),
        (EnrollmentProgress::Submitted, "Submitted to the network"),
        (EnrollmentProgress::Confirming, "Confirmed on chain"),
    ];
    let list = steps.iter().enumerate().fold(col(), |c, (i, &(stage, label))| {
        // Stages up to the current one are done; the next is in progress.
        let done = stage <= a.progress;
        let current = !done && steps.iter().find(|(s, _)| *s > a.progress).is_some_and(|(s, _)| *s == stage);
        let marker = if done {
            step_circle(t.link).child(check(t.paper, 14.0))
        } else if current {
            step_circle(t.tint).child(
                kit::dot(t.link, false).cycle(Cycle { period: 1.2, phase: 0.0, stops: &[(0.0, 1.0), (0.5, 0.25), (1.0, 1.0)], still: 1.0, fps: 30.0 }),
            )
        } else {
            step_circle(t.chip).child(text((i + 1).to_string()).font(type_::LABEL).color(t.faint))
        };
        let marker = marker.key("mark").transition(Transition::scale(0.6).allow_small_scale().springs(motion::ARRIVE));
        let words = text(label).font(type_::BODY).color(if done || current { t.ink } else { t.muted });
        c.child(step(t, marker, i + 1 == steps.len(), words).key(label))
    });
    page(
        t,
        col()
            .w(COLUMN)
            .child(kit::mark(t, 40.0, true))
            .child(el().h(space::XL))
            .child(intro(
                t,
                "Waiting for confirmation",
                format!("Your phone approved this {} for @{}. It joins the account once the network confirms it, usually within a minute.", super::device(), a.handle),
            ))
            .child(el().h(space::XL + space::S))
            .child(list)
            .children(a.trouble.map(|trouble| {
                let words = match trouble {
                    Unreachable::Chain => "Can't reach the network right now. Your approval is saved here; this keeps checking.",
                    Unreachable::Api => "Can't reach the qop server right now. Your approval is saved here; this keeps checking.",
                };
                // Top-aligned: the dot sits on the first line of the wrapped text.
                kit::surface(row().key("trouble").mt(space::XL).padding(space::M).gap(space::S).items_start(), radius::CONTROL, t.tint)
                    .child(kit::dot(t.link, true).mt(6.0))
                    .child(text(words).font(type_::SMALL).color(t.ink).wrap().grow(1.0).min_w(0.0))
                    .transition(Transition::opacity().springs(motion::SWAP))
            }))
            .child(el().h(space::XL + space::S))
            .child(row().child(kit::button(t, "stop-waiting", "Stop waiting", Kind::Secondary, |ui: &mut Ui, _| ui.send(Command::StopWaiting)))),
    )
}

pub fn revoked(t: &Theme, r: &Revoked) -> El {
    page(
        t,
        col()
            .w(COLUMN)
            .child(kit::mark(&Theme { brand: t.faint, mark_tile: t.chip, ..*t }, 40.0, false))
            .child(el().h(space::XL))
            .child(intro(
                t,
                format!("This {} was unlinked", super::device()),
                format!(
                    "It was removed from @{} on your phone, so its key and the messages stored here have been erased. Start over to link it again; it gets a new key.",
                    r.handle
                ),
            ))
            .child(el().h(space::XL + space::S))
            .child(row().child(kit::button(t, "start-over", "Start over", Kind::Primary, |ui: &mut Ui, _| ui.send(Command::AcknowledgeRevoked)).default_button())),
    )
}
