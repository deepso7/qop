//! qop's building blocks: notched surfaces, buttons, fields, status marks, the logo and the QR.

use std::cell::RefCell;

use rune::{Color, Cursor, Cycle, El, Pixels, Shape, TextEdit, Tx, canvas, el, row, text, text_input};

use super::theme::{Theme, space, type_};

/// Stepped corners, the pixel version of a rounded rect (`--qp-notch` and `--qp-notch-sm`).
#[derive(Clone, Copy)]
pub enum Notch {
    /// Two 3 pt steps (6 pt in all).
    Large,
    /// One 3 pt step.
    Small,
}

impl Notch {
    /// The corner's steps, top down, as (horizontal, vertical) insets from the box's edges.
    fn steps(self) -> &'static [(f32, f32)] {
        match self {
            Notch::Large => &[(6.0, 0.0), (3.0, 3.0), (0.0, 6.0)],
            Notch::Small => &[(3.0, 0.0), (0.0, 3.0)],
        }
    }
}

/// Quads that paint `color` in a notched shape inset by `by` points, behind content: a strip
/// per step at the top and bottom and one body between. They don't overlap, so a translucent
/// colour washes evenly.
fn layers(notch: Notch, color: Color, by: f32) -> Vec<El> {
    let steps = notch.steps();
    let quad = |e: El| e.fill(color).a11y_hidden();
    let mut out = Vec::with_capacity(steps.len() * 2 - 1);
    for pair in steps.windows(2) {
        let ((x, y), h) = (pair[0], pair[1].1 - pair[0].1);
        out.push(quad(el().pin(Some(x + by), Some(y + by), Some(x + by), None).h(h)));
        out.push(quad(el().pin(Some(x + by), None, Some(x + by), Some(y + by)).h(h)));
    }
    let (x, y) = steps[steps.len() - 1];
    out.push(quad(el().pin(Some(x + by), Some(y + by), Some(x + by), Some(y + by))));
    out
}

/// Paints `e` as a notched surface: `fill`, with an optional 1 pt `border` that follows the steps.
/// With a border both colours must be opaque (the fill sits on the border's shape).
/// Call it before adding children, so the paint sits under them.
pub fn notched(e: El, notch: Notch, fill: Color, border: Option<Color>) -> El {
    match border {
        Some(b) => e.children(layers(notch, b, 0.0)).children(layers(notch, fill, 1.0)),
        None => e.children(layers(notch, fill, 0.0)),
    }
}

/// A notched hover wash for a `hover_group` element: fades in under the pointer, no commit.
pub fn hover_wash(notch: Notch, color: Color) -> El {
    el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).group_opacity(0.0, 1.0).children(layers(notch, color, 0.0))
}

/// How a button reads.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The one main action on a screen.
    Primary,
    /// A bordered secondary action.
    Secondary,
    /// Text only until hovered.
    Quiet,
    /// Destructive: terracotta text and border.
    Danger,
}

/// A pressable notched button. `on` runs on click, Space, or Return when it is the default.
pub fn button<S: 'static>(t: &Theme, key: &str, label: &str, kind: Kind, on: impl Fn(&mut S, &mut Tx) + 'static) -> El {
    let (fill, border, ink) = match kind {
        Kind::Primary => (t.accent, None, t.on_accent),
        Kind::Secondary => (t.sheet, Some(t.border), t.ink),
        Kind::Quiet => (Color::TRANSPARENT, None, t.ink),
        Kind::Danger => (t.sheet, Some(t.tint_border), t.link),
    };
    let e = row().key(key).role("button").label(label).h(36.0).px(space::L).gap(space::S).center();
    notched(e, Notch::Small, fill, border)
        .child(hover_wash(Notch::Small, if kind == Kind::Primary { t.on_accent.alpha(0.12) } else { t.hover }))
        .child(text(label).font(type_::LABEL).color(ink).a11y_hidden())
        .hover_group()
        .focusable(true)
        .focus_ring(2.0, 2.0, t.brand)
        .cursor(Cursor::Pointer)
        .press_scale(0.97)
        .on_press_tx(on)
}

/// A square notched button showing `icon`, named `label` for screen readers and the tooltip.
pub fn icon_button<S: 'static>(t: &Theme, key: &str, label: &str, icon: El, kind: Kind, on: impl Fn(&mut S, &mut Tx) + 'static) -> El {
    let (fill, border) = match kind {
        Kind::Secondary => (t.sheet, Some(t.border)),
        _ => (Color::TRANSPARENT, None),
    };
    let e = row().key(key).role("button").label(label).help(label).size(36.0, 36.0).center();
    notched(e, Notch::Small, fill, border)
        .child(hover_wash(Notch::Small, t.hover))
        .child(icon.a11y_hidden())
        .hover_group()
        .focusable(true)
        .focus_ring(2.0, 2.0, t.brand)
        .cursor(Cursor::Pointer)
        .press_scale(0.94)
        .on_press_tx(on)
}

/// A pixel gear, `size` points square, drawn on the same grid feel as the wordmark.
pub fn gear(color: Color, size: f32) -> El {
    const ROWS: [&str; 10] = [
        "....##....",
        ".##.##.##.",
        ".########.",
        "..######..",
        "####..####",
        "####..####",
        "..######..",
        ".########.",
        ".##.##.##.",
        "....##....",
    ];
    let shape = ROWS.iter().enumerate().fold(Shape::new(), |s, (y, row)| {
        row.bytes().enumerate().filter(|&(_, b)| b == b'#').fold(s, |s, (x, _)| {
            let (x, y) = (x as f32, y as f32);
            s.fill(vec![[x, y], [x + 1.0, y], [x + 1.0, y + 1.0], [x, y + 1.0]], color)
        })
    });
    canvas(shape.view_box(10.0, 10.0)).size(size, size)
}

/// A text link styled action (Unlink, Use another handle).
pub fn link<S: 'static>(t: &Theme, key: &str, label: &str, on: impl Fn(&mut S, &mut Tx) + 'static) -> El {
    text(label)
        .key(key)
        .role("button")
        .font(type_::SMALL)
        .color(t.link)
        .focusable(true)
        .focus_ring(2.0, 2.0, t.brand)
        .cursor(Cursor::Pointer)
        .on_press_tx(on)
}

/// A single-line notched input. `prefix` (such as `@`) sits before the text in muted ink.
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
        let border = if self.edit.focused { t.brand } else { t.border };
        let input = text_input(self.edit, type_::BODY)
            .key(self.key)
            .single_line()
            .grow(1.0)
            .color(t.ink)
            .caret(t.brand, t.tint)
            .placeholder(self.placeholder, t.muted)
            .on_edit(access)
            .on_submit(submit);
        let mut field = notched(row().key(format!("{}-box", self.key)).w_full().h(40.0).px(space::M).gap(2.0).center_y(), Notch::Small, t.sheet, Some(border));
        if let Some(p) = self.prefix {
            field = field.child(text(p).font(type_::BODY).color(t.muted).a11y_hidden());
        }
        field.child(input)
    }
}

/// A small square status mark: filled, or hollow (`ring`) for something still pending.
pub fn dot(color: Color, ring: bool) -> El {
    let d = el().size(7.0, 7.0).a11y_hidden();
    if ring { d.border(1.5, color) } else { d.fill(color) }
}

/// An upper-case section label.
pub fn caption(t: &Theme, s: &str) -> El {
    text(s.to_uppercase()).font(type_::CAPTION).color(t.muted)
}

/// A pale foam chip with dark text (the fingerprint).
pub fn chip(t: &Theme, s: impl Into<String>) -> El {
    notched(row().h(20.0).px(7.0).center(), Notch::Small, t.foam, Some(t.foam.mix(t.on_foam, 0.12))).child(text(s).font(type_::CAPTION).color(t.on_foam))
}

/// A fingerprint in two groups: `9F3A21C4` as `9F3A 21C4`.
pub fn group(fingerprint: &str) -> String {
    let (a, b) = fingerprint.split_at(fingerprint.len() / 2);
    format!("{a} {b}")
}

/// A terracotta count (unread messages).
pub fn badge(t: &Theme, n: u32) -> El {
    notched(row().h(18.0).min_w(18.0).px(5.0).center(), Notch::Small, t.accent, None).child(text(n.to_string()).font(type_::CAPTION).color(t.on_accent))
}

/// The `qop` wordmark from `web/public/logo.svg`, `h` points tall.
pub fn wordmark(color: Color, h: f32) -> El {
    const RECTS: [[f32; 4]; 12] = [
        [32.0, 16.0, 64.0, 32.0], [16.0, 32.0, 32.0, 64.0], [80.0, 32.0, 32.0, 112.0], [32.0, 80.0, 64.0, 32.0],
        [144.0, 16.0, 64.0, 32.0], [128.0, 32.0, 32.0, 64.0], [192.0, 32.0, 32.0, 64.0], [144.0, 80.0, 64.0, 32.0],
        [240.0, 16.0, 80.0, 32.0], [240.0, 16.0, 32.0, 128.0], [304.0, 32.0, 32.0, 64.0], [272.0, 80.0, 48.0, 32.0],
    ];
    let shape = RECTS.iter().fold(Shape::new(), |s, &[x, y, w, h]| {
        let y = y - 16.0;
        s.fill(vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]], color)
    });
    canvas(shape.view_box(352.0, 128.0)).size(h * 352.0 / 128.0, h).label("qop")
}

/// The app icon (`web/public/icon.svg`): a terracotta pixel o on a dark notched tile. With
/// `busy`, its four strokes pulse in turn, clockwise.
pub fn mark(t: &Theme, size: f32, busy: bool) -> El {
    // The o's strokes in the icon's 1024 grid: top, right, bottom, left.
    const STROKES: [[f32; 4]; 4] =
        [[320.0, 224.0, 384.0, 192.0], [608.0, 320.0, 192.0, 384.0], [320.0, 608.0, 384.0, 192.0], [224.0, 320.0, 192.0, 384.0]];
    const PULSE: &[(f32, f32)] = &[(0.0, 1.0), (0.25, 0.3), (0.6, 0.3), (1.0, 1.0)];
    let k = size / 1024.0;
    let tile = notched(el().size(size, size), Notch::Large, t.mark_tile, None).a11y_hidden();
    STROKES.iter().enumerate().fold(tile, |tile, (i, &[x, y, w, h])| {
        let stroke = el().absolute(x * k, y * k).size(w * k, h * k).fill(t.brand);
        tile.child(if busy {
            stroke.cycle(Cycle { period: 1.4, phase: i as f32 * 0.25, stops: PULSE, still: 1.0, fps: 30.0 })
        } else {
            stroke
        })
    })
}

/// A row of square blocks that empties left to right as `fraction` falls from 1 to 0.
pub fn blocks(t: &Theme, key: &str, fraction: f32, count: usize) -> El {
    let lit = (fraction.clamp(0.0, 1.0) * count as f32).ceil() as usize;
    (0..count).fold(row().key(key).gap(2.0).a11y_hidden(), |r, i| {
        let on = i >= count - lit;
        r.child(el().key(format!("b{i}")).size(5.0, 5.0).fill(if on { t.brand } else { t.border }).motion(super::theme::motion::TICK))
    })
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

/// A notched card: the sheet with a hairline border.
pub fn card(t: &Theme, e: El) -> El {
    notched(e, Notch::Large, t.sheet, Some(t.border))
}
