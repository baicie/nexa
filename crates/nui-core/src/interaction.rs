//! Deterministic interaction-state transitions shared by buttons and other
//! pressable controls.

use std::ops::{BitOr, BitOrAssign};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteractionState {
    Idle,
    Hovered,
    Pressed,
    Focused,
    Disabled,
}

/// Additive, paint-facing interaction state with stable bit assignments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[repr(transparent)]
pub struct InteractionStateToken(u8);

impl InteractionStateToken {
    pub const IDLE: Self = Self(0);
    pub const HOVERED: Self = Self(1 << 0);
    pub const PRESSED: Self = Self(1 << 1);
    pub const FOCUSED: Self = Self(1 << 2);
    pub const DISABLED: Self = Self(1 << 3);

    #[must_use]
    pub const fn bits(self) -> u8 {
        self.0
    }

    #[must_use]
    pub const fn contains(self, state: Self) -> bool {
        self.0 & state.0 == state.0
    }
}

impl BitOr for InteractionStateToken {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for InteractionStateToken {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InteractionModel {
    hovered: bool,
    pointer_pressed: bool,
    keyboard_pressed: bool,
    focused: bool,
    disabled: bool,
}

impl Default for InteractionModel {
    fn default() -> Self {
        Self::new()
    }
}

impl InteractionModel {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            hovered: false,
            pointer_pressed: false,
            keyboard_pressed: false,
            focused: false,
            disabled: false,
        }
    }

    #[must_use]
    pub const fn state(self) -> InteractionState {
        if self.disabled {
            InteractionState::Disabled
        } else if self.pointer_pressed || self.keyboard_pressed {
            InteractionState::Pressed
        } else if self.focused {
            InteractionState::Focused
        } else if self.hovered {
            InteractionState::Hovered
        } else {
            InteractionState::Idle
        }
    }

    #[must_use]
    pub fn token(self) -> InteractionStateToken {
        let mut token = InteractionStateToken::IDLE;
        if self.hovered {
            token |= InteractionStateToken::HOVERED;
        }
        if self.pointer_pressed || self.keyboard_pressed {
            token |= InteractionStateToken::PRESSED;
        }
        if self.focused {
            token |= InteractionStateToken::FOCUSED;
        }
        if self.disabled {
            token |= InteractionStateToken::DISABLED;
        }
        token
    }

    pub fn set_disabled(&mut self, disabled: bool) {
        self.disabled = disabled;
        if disabled {
            self.pointer_pressed = false;
            self.keyboard_pressed = false;
        }
    }

    pub fn set_focused(&mut self, focused: bool) {
        if !focused || !self.disabled {
            self.focused = focused;
        }
        if !focused {
            self.keyboard_pressed = false;
        }
    }

    pub fn pointer_enter(&mut self) {
        if !self.disabled {
            self.hovered = true;
        }
    }

    pub fn pointer_leave(&mut self) {
        self.hovered = false;
        self.pointer_pressed = false;
    }

    pub fn pointer_press(&mut self) -> bool {
        if self.disabled {
            return false;
        }
        self.pointer_pressed = true;
        true
    }

    /// Release and return whether the control should invoke its action. A
    /// release outside the pressed target cancels the action.
    pub fn pointer_release(&mut self, over_target: bool) -> bool {
        let invoke = !self.disabled && self.pointer_pressed && over_target;
        self.pointer_pressed = false;
        invoke
    }

    pub fn keyboard_invoke(&mut self) -> bool {
        !self.disabled
    }

    pub fn keyboard_press(&mut self) -> bool {
        if self.disabled || self.keyboard_pressed {
            return false;
        }
        self.keyboard_pressed = true;
        true
    }

    pub fn keyboard_release(&mut self) -> bool {
        std::mem::take(&mut self.keyboard_pressed)
    }
}

#[cfg(test)]
mod tests {
    use super::{InteractionModel, InteractionState, InteractionStateToken};

    #[test]
    fn pointer_release_only_invokes_when_press_returns_to_target() {
        let mut state = InteractionModel::new();
        state.pointer_enter();
        assert_eq!(state.state(), InteractionState::Hovered);
        assert!(state.pointer_press());
        assert_eq!(state.state(), InteractionState::Pressed);
        assert!(!state.pointer_release(false));
        assert!(!state.pointer_release(true));
    }

    #[test]
    fn disabled_state_wins_and_blocks_pointer_and_keyboard_actions() {
        let mut state = InteractionModel::new();
        state.set_disabled(true);
        assert_eq!(state.state(), InteractionState::Disabled);
        assert!(!state.pointer_press());
        assert!(!state.keyboard_invoke());
        state.set_disabled(false);
        state.set_focused(true);
        assert_eq!(state.state(), InteractionState::Focused);
    }

    #[test]
    fn token_preserves_hover_press_and_focus_as_additive_state() {
        let mut state = InteractionModel::new();
        state.pointer_enter();
        state.set_focused(true);
        assert!(state.token().contains(InteractionStateToken::HOVERED));
        assert!(state.token().contains(InteractionStateToken::FOCUSED));

        assert!(state.pointer_press());
        assert!(state.token().contains(InteractionStateToken::HOVERED));
        assert!(state.token().contains(InteractionStateToken::PRESSED));
        assert!(state.token().contains(InteractionStateToken::FOCUSED));
    }

    #[test]
    fn keyboard_press_and_release_toggle_pressed_without_losing_focus() {
        let mut state = InteractionModel::new();
        state.set_focused(true);

        assert!(state.keyboard_press());
        assert!(state.token().contains(InteractionStateToken::PRESSED));
        assert!(state.token().contains(InteractionStateToken::FOCUSED));
        assert!(!state.keyboard_press(), "an armed key cannot invoke twice");

        assert!(state.keyboard_release());
        assert!(!state.token().contains(InteractionStateToken::PRESSED));
        assert!(state.token().contains(InteractionStateToken::FOCUSED));
        assert!(!state.keyboard_release());

        state.set_disabled(true);
        assert!(!state.keyboard_press());
    }

    #[test]
    fn focus_loss_cancels_keyboard_press_without_clearing_pointer_press() {
        let mut pointer = InteractionModel::new();
        assert!(pointer.pointer_press());
        pointer.set_focused(false);
        assert_eq!(pointer.state(), InteractionState::Pressed);

        let mut keyboard = InteractionModel::new();
        keyboard.set_focused(true);
        assert!(keyboard.keyboard_press());
        keyboard.set_focused(false);
        assert_eq!(keyboard.state(), InteractionState::Idle);
    }
}
