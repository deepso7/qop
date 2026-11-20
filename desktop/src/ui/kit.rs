//! qop's building blocks: squircle surfaces, buttons, fields, status marks, the logo and the QR.
//! Every rounded corner is a squircle (`continuous_corners`), as `corner-shape: squircle` is on
//! the web.

use std::cell::RefCell;

use rune::{Color, Cursor, Cycle, El, Pixels, Shape, TextEdit, Tx, canvas, el, row, text, text_input};

use super::theme::{Theme, radius, space, type_};

/// Rounds `e` into a squircle `r` points in radius, filled with `fill`.
pub fn surface(e: El, r: f32, fill: Color) -> El {
    e.radius(r).continuous_corners().fill(fill)
}

/// A raised panel: the element fill on paper, no border (the QR card, onboarding cards).
pub fn card(t: &Theme, e: El) -> El {
    surface(e, radius::PANEL, t.element)
}

/// How a button reads.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The one main action on a screen: terracotta, paper text.
    Primary,
    /// A soft ink chip, like the site's search pill.
    Secondary,
    /// Muted text until hovered.
    Quiet,
    /// Destructive: danger red text on a danger-tinted chip.
    Danger,
}

/// A pressable button. `on` runs on click, Space, or Return when it is the default.
pub fn button<S: 'static>(t: &Theme, key: &str, label: &str, kind: Kind, on: impl Fn(&mut S, &mut Tx) + 'static) -> El {
    let (fill, ink, hover) = match kind {
        Kind::Primary => (t.link, t.paper, t.paper.alpha(0.12)),
        Kind::Secondary => (t.chip, t.ink, t.hover),
        Kind::Quiet => (Color::TRANSPARENT, t.muted, t.hover),
        Kind::Danger => (t.danger_chip, t.danger, t.danger_hover),
    };
    let label_el = text(label).font(type_::LABEL).color(ink).a11y_hidden();
    let label_el = if kind == Kind::Quiet { label_el.group_color(t.ink) } else { label_el };
    surface(row().key(key).role("button").label(label).h(34.0).px(14.0).gap(space::S).center(), radius::CONTROL, fill)
        .hover(hover)
        .child(label_el)
        .hover_group()
        .focusable(true)
        .focus_ring(2.0, 2.0, t.brand)
        .cursor(Cursor::Pointer)
        .press_scale(0.97)
        .on_press_tx(on)
}

/// A square button showing `icon`, named `label` for screen readers and the tooltip.
pub fn icon_button<S: 'static>(t: &Theme, key: &str, label: &str, icon: El, on: impl Fn(&mut S, &mut Tx) + 'static) -> El {
    surface(row().key(key).role("button").label(label).help(label).size(28.0, 28.0).center(), 8.0, Color::TRANSPARENT)
        .hover(t.hover)
        .child(icon.a11y_hidden())
        .hover_group()
        .focusable(true)
        .focus_ring(2.0, 2.0, t.brand)
        .cursor(Cursor::Pointer)
        .press_scale(0.94)
        .on_press_tx(on)
}

/// A line gear (settings), `size` points square, stroked in `color` like the site's icons.
pub fn gear(color: Color, size: f32) -> El {
    let c = 12.0;
    let ring: Vec<[f32; 2]> = (0..=48)
        .map(|i| {
            let a = i as f32 / 48.0 * std::f32::consts::TAU;
            // Eight teeth: the radius steps out over each tooth.
            let tooth = ((a * 8.0 / std::f32::consts::TAU).fract() < 0.5) as u8 as f32;
            let r = 7.0 + tooth * 1.6;
            [c + r * a.cos(), c + r * a.sin()]
        })
        .collect();
    let hub: Vec<[f32; 2]> = (0..=24)
        .map(|i| {
            let a = i as f32 / 24.0 * std::f32::consts::TAU;
            [c + 3.0 * a.cos(), c + 3.0 * a.sin()]
        })
        .collect();
    let shape = Shape::new().stroke(ring, 1.5, color).stroke(hub, 1.5, color);
    canvas(shape.view_box(24.0, 24.0)).size(size, size)
}

/// A text action in terracotta, underlined on hover like site links.
pub fn link<S: 'static>(t: &Theme, key: &str, label: &str, on: impl Fn(&mut S, &mut Tx) + 'static) -> El {
    text(label)
        .key(key)
        .role("button")
        .font(type_::SMALL)
        .color(t.link)
        .group_color(t.ink)
        .hover_group()
        .focusable(true)
        .focus_ring(2.0, 2.0, t.brand)
        .cursor(Cursor::Pointer)
        .on_press_tx(on)
}

pub fn danger_link<S: 'static>(t: &Theme, key: &str, label: &str, on: impl Fn(&mut S, &mut Tx) + 'static) -> El {
    link(t, key, label, on).color(t.danger).group_color(t.danger).focus_ring(2.0, 2.0, t.danger)
}

/// A single-line input on a soft chip, ringed in terracotta while focused. `prefix` (such as `@`)
/// sits before the text in muted ink.
pub struct Field<'a> {
    pub key: &'a str,
    pub edit: &'a TextEdit,
    pub placeholder: &'a str,
    pub prefix: Option<&'a str>,
}

impl Field<'_> {
    pub fn build<S: 'static>(
        self,
        t: &Theme,
        access: impl for<'b> Fn(&'b mut S) -> &'b mut TextEdit + 'static,
        submit: impl Fn(&mut S, &mut Tx) + 'static,
    ) -> El {
        let input = text_input(self.edit, type_::BODY)
            .key(self.key)
            .single_line()
            .grow(1.0)
            .color(t.ink)
            .caret(t.brand, t.tint)
            .placeholder(self.placeholder, t.faint)
            .on_edit(access)
            .on_submit(submit);
        let ring = if self.edit.focused { t.brand } else { Color::TRANSPARENT };
        let mut field = surface(row().key(format!("{}-box", self.key)).w_full().h(40.0).px(space::M).gap(2.0).center_y(), radius::CONTROL, t.chip)
            .border(1.0, ring);
        if let Some(p) = self.prefix {
            field = field.child(text(p).font(type_::BODY).color(t.muted).a11y_hidden());
        }
        field.child(input)
    }
}

/// A small round status mark: filled, or hollow (`ring`) for something still pending.
pub fn dot(color: Color, ring: bool) -> El {
    let d = el().size(7.0, 7.0).radius(3.5).a11y_hidden();
    if ring { d.border(1.5, color) } else { d.fill(color) }
}

/// A section label in Paper Mono, sentence case and faint, like the site's sidebar groups.
pub fn caption(t: &Theme, s: &str) -> El {
    text(s).font(type_::CAPTION).color(t.faint)
}

/// A mono chip for codes (the fingerprint), like the site's `kbd`.
pub fn chip(t: &Theme, s: impl Into<String>) -> El {
    surface(row().h(22.0).px(8.0).center(), 7.0, t.chip).child(text(s).font(type_::DIGITS).color(t.ink))
}

/// A fingerprint in two groups: `9F3A21C4` as `9F3A 21C4`.
pub fn group(fingerprint: &str) -> String {
    let (a, b) = fingerprint.split_at(fingerprint.len() / 2);
    format!("{a} {b}")
}

/// A terracotta count pill (unread messages).
pub fn badge(t: &Theme, n: u32) -> El {
    row()
        .h(18.0)
        .min_w(18.0)
        .px(5.0)
        .center()
        .radius(9.0)
        .fill(t.link)
        .child(text(n.to_string()).font(type_::CAPTION).color(t.paper))
}

/// The site's logo row: the small terracotta o and `qop` in Inter semibold.
pub fn logo(t: &Theme) -> El {
    row().gap(space::S).center_y().label("qop").child(mark_o(t.brand, 14.0)).child(text("qop").font(type_::HEADING).color(t.ink).a11y_hidden())
}

/// The o's strokes in the icon's 1024 grid: top, right, bottom, left.
const STROKES: [[f32; 4]; 4] = [[320.0, 224.0, 384.0, 192.0], [608.0, 320.0, 192.0, 384.0], [320.0, 608.0, 384.0, 192.0], [224.0, 320.0, 192.0, 384.0]];

/// The pixel o alone, `size` points square, cropped to its strokes.
fn mark_o(color: Color, size: f32) -> El {
    let shape = STROKES.iter().fold(Shape::new(), |s, &[x, y, w, h]| {
        let (x, y) = (x - 224.0, y - 224.0);
        s.fill(vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]], color)
    });
    canvas(shape.view_box(576.0, 576.0)).size(size, size).a11y_hidden()
}

/// The app icon (`web/public/icon.svg`): a terracotta pixel o on a squircle tile. With `busy`,
/// its four strokes pulse in turn, clockwise.
pub fn mark(t: &Theme, size: f32, busy: bool) -> El {
    const PULSE: &[(f32, f32)] = &[(0.0, 1.0), (0.25, 0.3), (0.6, 0.3), (1.0, 1.0)];
    let k = size / 1024.0;
    let tile = surface(el().size(size, size), size * 0.225, t.mark_tile).a11y_hidden();
    STROKES.iter().enumerate().fold(tile, |tile, (i, &[x, y, w, h])| {
        let stroke = el().absolute(x * k, y * k).size(w * k, h * k).fill(t.brand);
        tile.child(if busy {
            stroke.cycle(Cycle { period: 1.4, phase: i as f32 * 0.25, stops: PULSE, still: 1.0, fps: 30.0 })
        } else {
            stroke
        })
    })
}

/// A thin rounded bar that empties left to right as `fraction` falls from 1 to 0 (countdowns).
pub fn progress(t: &Theme, key: &str, fraction: f32) -> El {
    let fill = el().key(format!("{key}-fill")).h_full().w_frac(fraction.clamp(0.0, 1.0)).radius(2.0).fill(t.brand).motion(super::theme::motion::TICK);
    row().key(key).h(4.0).w_full().radius(2.0).fill(t.chip).a11y_hidden().child(fill)
}

/// The QR code for one offer, rasterised once per payload and kept in UI state.
#[derive(Default)]
pub struct QrCache(RefCell<Option<Qr>>);

struct Qr {
    code: String,
    pixels: Pixels,
    modules: u32,
}

impl QrCache {
    /// The QR for `code`, `side` points square at most, drawn crisp at 1× and 2×.
    pub fn view(&self, code: &str, side: f32, dark: Color, light: Color) -> El {
        let mut slot = self.0.borrow_mut();
        if slot.as_ref().is_none_or(|q| q.code != code) {
            *slot = Some(Qr::render(code, dark, light));
        }
        let Some(qr) = slot.as_ref() else { return el() };
        // Whole points per module, so every module edge lands on a device pixel.
        let module = (side / qr.modules as f32).floor().max(1.0);
        let drawn = module * qr.modules as f32;
        el().size(drawn, drawn).pixels(&qr.pixels).role("image").label("Pairing QR code")
    }
}

impl Qr {
    /// Texels per module: even, so 1× samples land inside modules, and 2× maps one to one at 3 pt.
    const TEXELS: u32 = 6;

    fn render(code: &str, dark: Color, light: Color) -> Qr {
        let qr = qrcode::QrCode::with_error_correction_level(code.as_bytes(), qrcode::EcLevel::L)
            .or_else(|_| qrcode::QrCode::new(code.as_bytes()))
            .expect("a pairing code fits a QR code");
        let modules = qr.width() as u32;
        let colors = qr.to_colors();
        let px = modules * Self::TEXELS;
        let (dark, light) = (srgb8(dark), srgb8(light));
        let mut rgba = Vec::with_capacity((px * px * 4) as usize);
        for y in 0..px {
            for x in 0..px {
                let i = (y / Self::TEXELS * modules + x / Self::TEXELS) as usize;
                rgba.extend_from_slice(if colors[i] == qrcode::Color::Dark { &dark } else { &light });
            }
        }
        let pixels = Pixels::new();
        pixels.set(px, px, rgba);
        Qr { code: code.to_owned(), pixels, modules }
    }
}

/// An opaque colour as straight sRGB bytes (Rune's colours are linear).
fn srgb8(c: Color) -> [u8; 4] {
    let enc = |v: f32| {
        let v = v.clamp(0.0, 1.0);
        let s = if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
        (s * 255.0).round() as u8
    };
    [enc(c.r), enc(c.g), enc(c.b), 255]
}
