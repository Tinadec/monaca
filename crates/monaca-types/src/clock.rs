//! The clock abstraction.
//!
//! Token issuance, expiry checks and audit timestamps all read the clock. Routing them through
//! one trait means a test can pin "now" without sleeping, and it keeps `time::OffsetDateTime`
//! out of every signature that only needs "the current instant".

use time::OffsetDateTime;

/// A source of the current UTC instant.
///
/// Required to be `Send + Sync` because a single clock is shared by every task.
pub trait Clock: Send + Sync + 'static {
    /// The current instant.
    fn now(&self) -> OffsetDateTime;
}

/// The production clock, reading the system time.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

/// A clock frozen at one instant, for tests.
#[derive(Debug, Clone, Copy)]
pub struct FixedClock {
    instant: OffsetDateTime,
}

impl FixedClock {
    /// A clock that always reports `instant`.
    pub const fn new(instant: OffsetDateTime) -> Self {
        Self { instant }
    }
}

impl Clock for FixedClock {
    fn now(&self) -> OffsetDateTime {
        self.instant
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Duration;

    #[test]
    fn system_clock_moves_forward() {
        let clock = SystemClock;
        let first = clock.now();
        let second = clock.now();
        assert!(second >= first, "a system clock must not go backwards");
    }

    #[test]
    fn fixed_clock_is_stable() {
        let instant = OffsetDateTime::from_unix_timestamp(1_767_225_600).expect("valid timestamp");
        let clock = FixedClock::new(instant);
        assert_eq!(clock.now(), instant);
        assert_eq!(clock.now(), clock.now());
    }

    #[test]
    fn fixed_clock_does_not_observe_wall_clock_progress() {
        let instant = OffsetDateTime::from_unix_timestamp(1_767_225_600).expect("valid timestamp");
        let clock = FixedClock::new(instant);
        let later = instant + Duration::seconds(900);
        assert_eq!(clock.now(), instant);
        assert_eq!(clock.now() + Duration::seconds(900), later);
    }
}
