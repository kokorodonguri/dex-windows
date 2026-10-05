//! Where each app window should sit on the DeX display.
//!
//! Apps launched on a virtual display inherit bounds from the phone screen
//! (tall, larger than the display, or fullscreen), so they open cropped or
//! hidden behind the DeX taskbar. This module keeps, per task, the bounds we
//! asked for, notices when the user moves or resizes a window afterwards, and
//! only steps in again when a window would leave the usable area.

use std::collections::HashMap;

use crate::dex::DisplaySize;

/// Smallest window the device accepts (also guards degenerate safe areas).
pub const MIN_TASK_WIDTH: i32 = 320;
pub const MIN_TASK_HEIGHT: i32 = 240;

/// How often a resize is re-sent while the device has not adopted it yet.
const MAX_ATTEMPTS: u8 = 3;

/// Shape of a portrait window (width : height), like a phone standing up.
const PORTRAIT_WIDTH: i32 = 9;
const PORTRAIT_HEIGHT: i32 = 16;

/// The window an app gets until the user sizes it themselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fit {
    /// The whole safe area: apps that handle a wide window.
    Fill,
    /// A phone-shaped window as tall as the safe area, centred: apps locked
    /// to portrait, which Android would otherwise stretch sideways.
    Portrait,
}

/// Default bounds for a window of the given shape.
pub fn default_bounds(safe: Rect, fit: Fit) -> Rect {
    match fit {
        Fit::Fill => safe,
        Fit::Portrait => {
            let width = (safe.height() * PORTRAIT_WIDTH / PORTRAIT_HEIGHT).clamp(1, safe.width());
            let left = safe.left + (safe.width() - width) / 2;
            Rect::new(left, safe.top, left + width, safe.bottom)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }

    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    pub fn is_empty(&self) -> bool {
        self.width() <= 0 || self.height() <= 0
    }

    pub fn contains(&self, other: &Rect) -> bool {
        other.left >= self.left
            && other.top >= self.top
            && other.right <= self.right
            && other.bottom <= self.bottom
    }
}

/// Usable area of the display: the whole width, minus the DeX taskbar at the
/// bottom. Windows are positioned at the top edge, where DeX draws the window
/// title bar inside the task bounds.
pub fn safe_area(size: DisplaySize, bottom_inset: u32) -> Option<Rect> {
    let width = i32::try_from(size.width).ok()?;
    let height = i32::try_from(size.height.checked_sub(bottom_inset)?).ok()?;
    (width >= MIN_TASK_WIDTH && height >= MIN_TASK_HEIGHT).then(|| Rect::new(0, 0, width, height))
}

/// Moves and shrinks `rect` the least amount needed to fit inside `safe`.
pub fn fit_into(rect: Rect, safe: Rect) -> Rect {
    let width = rect.width().clamp(1, safe.width());
    let height = rect.height().clamp(1, safe.height());
    let left = rect.left.clamp(safe.left, safe.right - width);
    let top = rect.top.clamp(safe.top, safe.bottom - height);
    Rect::new(left, top, left + width, top + height)
}

/// Keeps a window's position and size relative to the area it lived in, so a
/// Flex resize of the display does not collapse the user's layout.
fn rescale(rect: Rect, from: Rect, to: Rect) -> Rect {
    if rect == from || from.is_empty() {
        return to;
    }
    let map = |value: i32, from_origin: i32, from_extent: i32, to_origin: i32, to_extent: i32| {
        to_origin
            + ((value - from_origin) as f64 * to_extent as f64 / from_extent as f64).round() as i32
    };
    let scaled = Rect::new(
        map(rect.left, from.left, from.width(), to.left, to.width()),
        map(rect.top, from.top, from.height(), to.top, to.height()),
        map(rect.right, from.left, from.width(), to.left, to.width()),
        map(rect.bottom, from.top, from.height(), to.top, to.height()),
    );
    fit_into(scaled, to)
}

#[derive(Debug, Clone, Copy)]
struct TaskState {
    /// Bounds the window is supposed to have: ours until the user moves it,
    /// theirs afterwards.
    expected: Rect,
    /// `expected` was actually observed on the device.
    confirmed: bool,
    attempts: u8,
    /// The user resized or moved the window: their size is kept from now on.
    detached: bool,
    fit: Fit,
}

pub struct LayoutTracker {
    safe: Rect,
    tasks: HashMap<u32, TaskState>,
}

impl LayoutTracker {
    pub fn new(safe: Rect) -> Self {
        Self {
            safe,
            tasks: HashMap::new(),
        }
    }

    /// Reports one live task, its current bounds (`None` when the dump did not
    /// carry them) and the shape its top activity wants. Returns the bounds to
    /// apply with `am task resize`.
    pub fn observe(&mut self, id: u32, bounds: Option<Rect>, fit: Fit) -> Option<Rect> {
        let safe = self.safe;
        let Some(state) = self.tasks.get_mut(&id) else {
            // A window shown for the first time gets the default layout for its
            // shape, whatever bounds it brought over from the phone screen.
            let expected = default_bounds(safe, fit);
            let confirmed = bounds == Some(expected);
            self.tasks.insert(
                id,
                TaskState {
                    expected,
                    confirmed,
                    attempts: 1,
                    detached: false,
                    fit,
                },
            );
            return (!confirmed).then_some(expected);
        };
        if fit != state.fit {
            state.fit = fit;
            // A splash screen often leaves the orientation open and the real
            // activity locks it: follow that while the layout is still ours.
            if !state.detached {
                state.expected = default_bounds(safe, fit);
                state.confirmed = bounds == Some(state.expected);
                state.attempts = 1;
                return (!state.confirmed).then_some(state.expected);
            }
        }
        let bounds = bounds?;
        if bounds == state.expected {
            state.confirmed = true;
            return None;
        }
        if !state.confirmed && state.attempts < MAX_ATTEMPTS {
            // The resize has not landed yet (or was dropped): ask again.
            state.attempts += 1;
            return Some(state.expected);
        }
        // Someone else owns these bounds now. Keep them unless the window has
        // left the usable area (under the taskbar, or partly off-screen).
        state.detached = true;
        state.expected = bounds;
        state.confirmed = true;
        if safe.contains(&bounds) {
            return None;
        }
        let fitted = fit_into(bounds, safe);
        state.expected = fitted;
        state.confirmed = false;
        state.attempts = 1;
        (fitted != bounds).then_some(fitted)
    }

    /// The display or the taskbar changed size (Flex). Returns the tasks to
    /// move, each keeping its position and size relative to the safe area.
    pub fn set_safe_area(&mut self, safe: Rect) -> Vec<(u32, Rect)> {
        if safe == self.safe {
            return Vec::new();
        }
        let previous = std::mem::replace(&mut self.safe, safe);
        let mut moves: Vec<(u32, Rect)> = self
            .tasks
            .iter_mut()
            .map(|(id, state)| {
                // Our own layout is recomputed for the new area; a size the
                // user chose is scaled along with the display.
                state.expected = if state.detached {
                    rescale(state.expected, previous, safe)
                } else {
                    default_bounds(safe, state.fit)
                };
                state.confirmed = false;
                state.attempts = 1;
                (*id, state.expected)
            })
            .collect();
        moves.sort_unstable_by_key(|(id, _)| *id);
        moves
    }

    /// Forgets tasks that are no longer listed, so a reopened app is laid out
    /// again from scratch.
    pub fn retain_live(&mut self, live: &[u32]) {
        self.tasks.retain(|id, _| live.contains(id));
    }

    #[cfg(test)]
    fn detached(&self, id: u32) -> bool {
        self.tasks[&id].detached
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAFE: Rect = Rect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1224,
    };

    fn confirm(tracker: &mut LayoutTracker, id: u32, bounds: Rect) {
        assert_eq!(tracker.observe(id, Some(bounds), Fit::Fill), None);
    }

    #[test]
    fn safe_area_excludes_the_taskbar_and_rejects_degenerate_displays() {
        assert_eq!(
            safe_area(
                DisplaySize {
                    width: 1920,
                    height: 1280
                },
                56
            ),
            Some(Rect::new(0, 0, 1920, 1224))
        );
        assert_eq!(
            safe_area(
                DisplaySize {
                    width: 1920,
                    height: 1280
                },
                0
            ),
            Some(Rect::new(0, 0, 1920, 1280))
        );
        assert_eq!(
            safe_area(
                DisplaySize {
                    width: 1920,
                    height: 300
                },
                280
            ),
            None
        );
        assert_eq!(
            safe_area(
                DisplaySize {
                    width: 1920,
                    height: 300
                },
                400
            ),
            None
        );
    }

    #[test]
    fn first_sight_fills_the_safe_area_whatever_the_phone_bounds_were() {
        let mut tracker = LayoutTracker::new(SAFE);
        // Portrait phone bounds, taller than the display.
        assert_eq!(
            tracker.observe(1, Some(Rect::new(0, 0, 1080, 2340)), Fit::Fill),
            Some(SAFE)
        );
        // Fullscreen bounds still hide content behind the taskbar.
        assert_eq!(
            tracker.observe(2, Some(Rect::new(0, 0, 1920, 1280)), Fit::Fill),
            Some(SAFE)
        );
        // Bounds unknown: lay it out anyway.
        assert_eq!(tracker.observe(3, None, Fit::Fill), Some(SAFE));
        // Already right: nothing to do.
        assert_eq!(tracker.observe(4, Some(SAFE), Fit::Fill), None);
    }

    #[test]
    fn a_resize_is_repeated_until_the_device_adopts_it_then_left_alone() {
        let mut tracker = LayoutTracker::new(SAFE);
        let stale = Rect::new(0, 0, 1080, 2340);
        assert_eq!(tracker.observe(1, Some(stale), Fit::Fill), Some(SAFE));
        assert_eq!(tracker.observe(1, Some(stale), Fit::Fill), Some(SAFE));
        assert_eq!(tracker.observe(1, Some(stale), Fit::Fill), Some(SAFE));
        // Giving up rather than fighting the device forever.
        assert_eq!(
            tracker.observe(1, Some(Rect::new(0, 0, 1000, 800)), Fit::Fill),
            None
        );
        confirm(&mut tracker, 1, Rect::new(0, 0, 1000, 800));
    }

    #[test]
    fn a_manual_resize_is_kept_until_the_window_leaves_the_safe_area() {
        let mut tracker = LayoutTracker::new(SAFE);
        assert_eq!(
            tracker.observe(1, Some(Rect::new(0, 0, 1080, 2340)), Fit::Fill),
            Some(SAFE)
        );
        confirm(&mut tracker, 1, SAFE);

        let manual = Rect::new(100, 80, 900, 700);
        assert_eq!(
            tracker.observe(1, Some(manual), Fit::Fill),
            None,
            "the user's own size must survive"
        );
        assert!(tracker.detached(1));
        assert_eq!(
            tracker.observe(1, Some(manual), Fit::Fill),
            None,
            "and must not be pulled back later"
        );

        // Dragged down under the DeX taskbar: only pushed back up.
        let hidden = Rect::new(100, 900, 900, 1520);
        assert_eq!(
            tracker.observe(1, Some(hidden), Fit::Fill),
            Some(Rect::new(100, 604, 900, 1224))
        );
        // Dragged off the left edge / above the title bar.
        confirm(&mut tracker, 1, Rect::new(100, 604, 900, 1224));
        assert_eq!(
            tracker.observe(1, Some(Rect::new(-300, -40, 500, 580)), Fit::Fill),
            Some(Rect::new(0, 0, 800, 620))
        );
    }

    #[test]
    fn flex_resize_keeps_the_relative_layout_inside_the_new_safe_area() {
        let mut tracker = LayoutTracker::new(SAFE);
        assert_eq!(
            tracker.observe(1, Some(Rect::new(0, 0, 1080, 2340)), Fit::Fill),
            Some(SAFE)
        );
        confirm(&mut tracker, 1, SAFE);
        assert_eq!(tracker.observe(2, Some(SAFE), Fit::Fill), None);
        let manual = Rect::new(960, 0, 1920, 612);
        assert_eq!(tracker.observe(2, Some(manual), Fit::Fill), None);

        let smaller = Rect::new(0, 0, 1280, 800);
        assert_eq!(
            tracker.set_safe_area(smaller),
            vec![(1, smaller), (2, Rect::new(640, 0, 1280, 400))],
            "a maximized window refills the display, a half-width one stays half-width"
        );
        assert_eq!(
            tracker.set_safe_area(smaller),
            Vec::new(),
            "no display change, no move"
        );
    }

    #[test]
    fn closed_tasks_are_laid_out_again_when_they_come_back() {
        let mut tracker = LayoutTracker::new(SAFE);
        assert_eq!(
            tracker.observe(7, Some(Rect::new(0, 0, 1080, 2340)), Fit::Fill),
            Some(SAFE)
        );
        confirm(&mut tracker, 7, SAFE);
        let manual = Rect::new(10, 10, 810, 610);
        assert_eq!(tracker.observe(7, Some(manual), Fit::Fill), None);

        tracker.retain_live(&[7]);
        assert_eq!(
            tracker.observe(7, Some(manual), Fit::Fill),
            None,
            "still open, still the user's"
        );
        tracker.retain_live(&[]);
        assert_eq!(tracker.observe(7, Some(manual), Fit::Fill), Some(SAFE));
    }

    #[test]
    fn portrait_apps_get_a_phone_shaped_window_instead_of_being_stretched() {
        let safe = Rect::new(0, 0, 1920, 1136);
        assert_eq!(
            default_bounds(safe, Fit::Portrait),
            Rect::new(640, 0, 1279, 1136),
            "9:16, full height, centred"
        );
        assert_eq!(default_bounds(safe, Fit::Fill), safe);
        // Never wider than the display, even on a tall Flex window.
        let narrow = Rect::new(0, 0, 400, 1200);
        assert_eq!(default_bounds(narrow, Fit::Portrait), narrow);

        let mut tracker = LayoutTracker::new(safe);
        assert_eq!(
            tracker.observe(1, Some(safe), Fit::Portrait),
            Some(Rect::new(640, 0, 1279, 1136))
        );
    }

    #[test]
    fn a_splash_screen_is_followed_by_the_orientation_of_the_real_activity() {
        let safe = Rect::new(0, 0, 1920, 1136);
        let portrait = default_bounds(safe, Fit::Portrait);
        let mut tracker = LayoutTracker::new(safe);
        assert_eq!(
            tracker.observe(1, Some(Rect::new(0, 0, 1080, 2340)), Fit::Fill),
            Some(safe)
        );
        confirm_fit(&mut tracker, 1, safe, Fit::Fill);
        // The main activity locks portrait: reshape while the layout is ours.
        assert_eq!(
            tracker.observe(1, Some(safe), Fit::Portrait),
            Some(portrait)
        );
        confirm_fit(&mut tracker, 1, portrait, Fit::Portrait);

        // Once the user has sized it, a later orientation change is theirs to handle.
        let manual = Rect::new(100, 100, 900, 900);
        assert_eq!(tracker.observe(1, Some(manual), Fit::Portrait), None);
        assert_eq!(tracker.observe(1, Some(manual), Fit::Fill), None);
    }

    #[test]
    fn flex_recomputes_a_portrait_window_instead_of_distorting_it() {
        let safe = Rect::new(0, 0, 1920, 1136);
        let mut tracker = LayoutTracker::new(safe);
        assert_eq!(
            tracker.observe(1, None, Fit::Portrait),
            Some(default_bounds(safe, Fit::Portrait))
        );
        let smaller = Rect::new(0, 0, 1280, 744);
        assert_eq!(
            tracker.set_safe_area(smaller),
            vec![(1, Rect::new(431, 0, 849, 744))]
        );
    }

    fn confirm_fit(tracker: &mut LayoutTracker, id: u32, bounds: Rect, fit: Fit) {
        assert_eq!(tracker.observe(id, Some(bounds), fit), None);
    }

    #[test]
    fn fitting_never_grows_a_window_beyond_the_safe_area() {
        let huge = fit_into(Rect::new(-100, -100, 4000, 4000), SAFE);
        assert_eq!(huge, SAFE);
        let tiny = fit_into(Rect::new(0, 0, 50, 50), Rect::new(0, 0, 200, 200));
        assert_eq!(
            tiny,
            Rect::new(0, 0, 50, 50),
            "small windows are not inflated"
        );
        assert!(SAFE.contains(&fit_into(Rect::new(1900, 1200, 2600, 1900), SAFE)));
    }
}
