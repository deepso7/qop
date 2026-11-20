//! qop's design tokens for the desktop, from `web/theme.css`: warm off-white paper, near-black
//! ink and one terracotta accent. Surfaces are soft squircle panels told apart by ink at low
//! opacity, not borders or shadows. Inter for text, Paper Mono for small labels and digits.

use rune::{Color, Spring, SpringPair, TextStyle, color::hex, oklch};

/// Inter and Paper Mono (both OFL), decompressed from `web/public/fonts/InterVariable.woff2` and
/// `web/fonts/PaperMono.woff2`. Both variable (Inter wght 100–900, Paper Mono 100–800).
pub const FONTS: &[&[u8]] = &[include_bytes!("../../assets/Inter.ttf"), include_bytes!("../../assets/PaperMono.ttf")];
/// The sans slot is Inter; `TextStyle::mono` picks Paper Mono.
pub const FAMILIES: (&str, &str) = ("Inter Variable", "Paper Mono");

/// The palette for one appearance. Built per view from the system appearance.
#[derive(Clone, Copy, Debug)]
pub struct Theme {
    /// Room the window's own controls take at the leading edge of the titlebar band (the macOS
    /// traffic lights); 0 where the native frame stays. Set per frame from `Cx::chrome_insets`.
    pub controls_lead: f32,
    /// The window background everywhere (`--qp-paper`).
    pub paper: Color,
    pub ink: Color,
    /// Secondary text: previews, descriptions, idle links (`--qp-muted`).
    pub muted: Color,
    /// Tertiary text: mono labels, timestamps (`--docs-faint`).
    pub faint: Color,
    /// Raised panels: the QR card, received bubbles, the composer (`--qp-element`).
    pub element: Color,
    /// Quiet controls and the selected row: ink at 6% (`--docs-chip`).
    pub chip: Color,
    /// Hover wash: ink at 4%.
    pub hover: Color,
    /// Hairline rings and dividers (`--qp-border`), used sparingly.
    pub border: Color,
    /// Brand terracotta for fills and art (`--qp-orange`).
    pub brand: Color,
    /// Terracotta that reads as text on paper, AA (`--qp-link`).
    pub link: Color,
    pub danger: Color,
    pub danger_chip: Color,
    pub danger_hover: Color,
    /// Sent bubbles: brand at 10%, the web's tint scale.
    pub tint: Color,
    /// The app icon's tile behind the terracotta o (`--qp-mark-tile`).
    pub mark_tile: Color,
    /// The QR's light modules, a fixed pale tile in both themes so phones scan it.
    pub qr_light: Color,
    pub qr_dark: Color,
}

impl Theme {
    /// Leading padding for a row in the titlebar band: clear of the window's controls with a small
    /// gap, or `rest` where there are none.
    pub fn band_lead(&self, rest: f32) -> f32 {
        if self.controls_lead > 0.0 { self.controls_lead + space::M } else { rest }
    }

    pub fn new(dark: bool) -> Theme {
        let qr_light = oklch(0.985, 0.004, 80.0);
        let qr_dark = oklch(0.2, 0.008, 30.0);
        // Text alphas for muted and faint ink, each at least 4.5:1 on paper and element.
        let (paper, ink, element, brand, link, mark_tile, (muted, faint)) = if dark {
            (
                oklch(0.165, 0.008, 40.0),
                oklch(0.95, 0.008, 70.0),
                oklch(0.205, 0.01, 40.0),
                oklch(0.7, 0.12, 48.0),
                oklch(0.76, 0.12, 52.0),
                oklch(0.171, 0.006, 237.0),
                (0.6, 0.5),
            )
        } else {
            (
                oklch(0.985, 0.004, 80.0),
                oklch(0.2, 0.008, 30.0),
                oklch(0.955, 0.006, 70.0),
                oklch(0.61, 0.112, 47.0),
                oklch(0.5, 0.11, 45.0),
                oklch(0.944, 0.02, 62.9),
                (0.66, 0.64),
            )
        };
        let danger = hex(if dark { "#FA6863" } else { "#C2181D" }).unwrap();
        Theme {
            controls_lead: 0.0,
            paper,
            ink,
            muted: ink.alpha(muted),
            faint: ink.alpha(faint),
            element,
            chip: ink.alpha(0.06),
            hover: ink.alpha(0.04),
            border: ink.alpha(0.1),
            brand,
            link,
            danger,
            danger_chip: danger.alpha(0.04),
            danger_hover: danger.alpha(0.02),
            tint: brand.alpha(if dark { 0.16 } else { 0.1 }),
            mark_tile,
            qr_light,
            qr_dark,
        }
    }
}

/// Corner radii. Every rounded corner is a squircle (`El::continuous_corners`), as on the web,
/// so they run generous.
pub mod radius {
    /// Large panels: the QR card, onboarding cards.
    pub const PANEL: f32 = 24.0;
    /// Bubbles and list rows.
    pub const CARD: f32 = 16.0;
    /// Buttons, fields, chips.
    pub const CONTROL: f32 = 12.0;
}

/// Type scale: Inter for reading, Paper Mono (`.mono()`) for small labels and digits.
pub mod type_ {
    use super::TextStyle;
    /// Screen headlines ("Nothing in the middle.").
    pub const DISPLAY: TextStyle = TextStyle::new(30.0, 600.0).lh(36.0).tracking(-0.9);
    /// Pane titles.
    pub const TITLE: TextStyle = TextStyle::new(20.0, 600.0).lh(26.0).tracking(-0.4);
    /// Lead paragraphs under a headline.
    pub const LEAD: TextStyle = TextStyle::new(16.0, 400.0).lh(24.0);
    pub const HEADING: TextStyle = TextStyle::new(14.0, 600.0).lh(20.0).tracking(-0.1);
    pub const BODY: TextStyle = TextStyle::new(14.0, 400.0).lh(20.0);
    pub const LABEL: TextStyle = TextStyle::new(13.0, 500.0).lh(18.0);
    pub const SMALL: TextStyle = TextStyle::new(13.0, 400.0).lh(18.0);
    /// Section labels, timestamps and status words, in Paper Mono, sentence case.
    pub const CAPTION: TextStyle = TextStyle::new(12.0, 400.0).lh(16.0).mono();
    /// Codes, fingerprints and countdowns that don't shift as they change.
    pub const DIGITS: TextStyle = TextStyle::new(12.0, 500.0).lh(16.0).mono().features("'tnum' 1");
}

/// Spacing on a 4 pt grid.
pub mod space {
    pub const XS: f32 = 4.0;
    pub const S: f32 = 8.0;
    pub const M: f32 = 12.0;
    pub const L: f32 = 16.0;
    pub const XL: f32 = 24.0;
    pub const XXL: f32 = 40.0;
}

/// Motion: calm and quick, like the site's 0.15 s colour fades. Reduced motion is handled by
/// Rune (travel snaps, fades stay).
pub mod motion {
    use super::{Spring, SpringPair};
    /// A screen replacing another.
    pub const SCREEN: SpringPair = SpringPair::new(Spring::new(0.4, 0.0), Spring::new(0.2, 0.0));
    /// A message or row arriving.
    pub const ARRIVE: SpringPair = SpringPair::new(Spring::new(0.35, 0.08), Spring::new(0.18, 0.0));
    /// Small state changes: a status word, a copied label.
    pub const SWAP: SpringPair = SpringPair::new(Spring::new(0.22, 0.0), Spring::new(0.15, 0.0));
    /// The countdown bar emptying.
    pub const TICK: Spring = Spring::new(0.5, 0.0);
}

/// Height of the titlebar band the window draws: the sidebar, chat and onboarding headers, with
/// the macOS traffic lights centred in it.
pub const TITLEBAR: f32 = 52.0;
