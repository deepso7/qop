//! qop's design tokens for the desktop, from `web/theme.css`: warm paper and terracotta in light,
//! a dark tide in dark, Paper Mono everywhere, stepped "pixel notch" corners.

use rune::{Color, Spring, SpringPair, TextStyle, oklch};

/// Paper Mono (OFL), decompressed from `web/fonts/PaperMono.woff2`. A variable font (wght 100–800).
pub const FONTS: &[&[u8]] = &[include_bytes!("../../assets/PaperMono.ttf")];
/// The sans and mono slots both point at Paper Mono.
pub const FAMILIES: (&str, &str) = ("Paper Mono", "Paper Mono");

/// The palette for one appearance. Built per view from the system appearance.
#[derive(Clone, Copy, Debug)]
pub struct Theme {
    /// Window background (the sidebar and onboarding screens).
    pub paper: Color,
    /// The reading surface beside the sidebar, a shade off paper.
    pub sheet: Color,
    pub ink: Color,
    /// Filled controls, received bubbles, the selected row.
    pub element: Color,
    pub border: Color,
    pub muted: Color,
    /// Brand terracotta for fills and art.
    pub brand: Color,
    /// Terracotta that reads as text on paper (AA).
    pub link: Color,
    /// Primary button fill and the text on it.
    pub accent: Color,
    pub on_accent: Color,
    /// Sent bubbles: terracotta washed into the sheet (opaque, so it can sit on a border).
    pub tint: Color,
    pub tint_border: Color,
    /// Pale chips that sit on the tide in both themes, with fixed dark text.
    pub foam: Color,
    pub on_foam: Color,
    /// The app icon's tile behind the terracotta o.
    pub mark_tile: Color,
    pub hover: Color,
}

impl Theme {
    pub fn new(dark: bool) -> Theme {
        let foam = oklch(0.944, 0.02, 62.9);
        let on_foam = oklch(0.17, 0.008, 250.0);
        if dark {
            let ink = oklch(0.94, 0.012, 60.0);
            let brand = oklch(0.7, 0.12, 48.0);
            let paper = oklch(0.17, 0.012, 45.0);
            Theme {
                paper,
                sheet: oklch(0.2, 0.013, 45.0),
                ink,
                element: oklch(0.25, 0.014, 45.0),
                border: oklch(0.32, 0.018, 45.0),
                muted: oklch(0.72, 0.015, 55.0),
                brand,
                link: oklch(0.74, 0.12, 50.0),
                accent: brand,
                on_accent: paper,
                tint: oklch(0.27, 0.035, 46.0),
                tint_border: oklch(0.42, 0.07, 47.0),
                foam,
                on_foam,
                mark_tile: oklch(0.12, 0.006, 237.0),
                hover: ink.alpha(0.06),
            }
        } else {
            let ink = oklch(0.17, 0.008, 250.0);
            let link = oklch(0.5, 0.11, 45.0);
            Theme {
                paper: oklch(0.95, 0.006, 60.0),
                sheet: oklch(0.975, 0.004, 60.0),
                ink,
                element: oklch(0.911, 0.0061, 51.5),
                border: oklch(0.833, 0.0063, 34.5),
                muted: oklch(0.4508, 0.00728, 311.2),
                brand: oklch(0.61, 0.112, 47.0),
                link,
                accent: link,
                on_accent: oklch(0.975, 0.004, 60.0),
                tint: oklch(0.935, 0.028, 52.0),
                tint_border: oklch(0.82, 0.06, 48.0),
                foam,
                on_foam,
                mark_tile: oklch(0.17, 0.008, 250.0),
                hover: ink.alpha(0.05),
            }
        }
    }
}

/// Type scale. Paper Mono is wide, so sizes run a step smaller than a proportional face's.
pub mod type_ {
    use super::TextStyle;
    pub const DISPLAY: TextStyle = TextStyle::new(26.0, 600.0).lh(32.0).tracking(-0.4);
    pub const TITLE: TextStyle = TextStyle::new(18.0, 600.0).lh(24.0).tracking(-0.2);
    pub const HEADING: TextStyle = TextStyle::new(14.0, 600.0).lh(20.0);
    pub const BODY: TextStyle = TextStyle::new(13.0, 400.0).lh(20.0);
    pub const LABEL: TextStyle = TextStyle::new(13.0, 500.0).lh(18.0);
    pub const SMALL: TextStyle = TextStyle::new(12.0, 400.0).lh(17.0);
    /// Upper-case section labels and status words.
    pub const CAPTION: TextStyle = TextStyle::new(11.0, 500.0).lh(14.0).tracking(0.6);
    /// Countdown digits that don't shift as they change.
    pub const DIGITS: TextStyle = TextStyle::new(12.0, 500.0).lh(17.0).features("'tnum' 1");
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

/// Motion: springy but restrained. Reduced motion is handled by Rune (travel snaps, fades stay).
pub mod motion {
    use super::{Spring, SpringPair};
    /// A screen replacing another.
    pub const SCREEN: SpringPair = SpringPair::new(Spring::new(0.45, 0.12), Spring::new(0.22, 0.0));
    /// A message or row arriving.
    pub const ARRIVE: SpringPair = SpringPair::new(Spring::new(0.38, 0.18), Spring::new(0.2, 0.0));
    /// Small state changes: a status word, a copied label.
    pub const SWAP: SpringPair = SpringPair::new(Spring::new(0.24, 0.0), Spring::new(0.16, 0.0));
    /// The countdown blocks emptying.
    pub const TICK: Spring = Spring::new(0.5, 0.0);
}
