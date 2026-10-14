//! How much memory this node's caches may hold (plans/CACHE.md, Stage 5).
//!
//! The node runs on a personal computer (plenty of RAM, rude to use it all), a server (plenty, rude
//! _not_ to use it), a VPS or a Raspberry Pi (little, and an out-of-memory kill is easy) and a phone
//! (little, and rude to use it all) - Curtis's phone has 12 GB, his server 16 GB (2026-10-13). One
//! budget for every cache, which each takes a share of; no cache knows where it's running.
//!
//! What it runs on: the shell says (`RINGTOME_DEVICE`, set by the desktop and Android apps before
//! the node starts), else it's a server. How much there is: the machine's memory, or - on Linux - a
//! cgroup's `memory.max` when that is tighter, since that's the line the kernel kills at.
//! `RINGTOME_CACHE_MEMORY` overrides it all: a size (`2GB`, `512MB`) or a share (`40%`); `0` turns
//! the caches off, which is always correct - every cache then misses.
//!
//! Pressure: a budget set at boot doesn't know what else the machine starts doing. Where available
//! memory can be read (Linux; Android's kernel is Linux), a beat checks it, and under a tenth of the
//! total every cache that asked is told to drop what it holds.

use std::sync::{Mutex, OnceLock};

/// What the node runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Device {
    Server,
    Computer,
    Phone,
}

impl Device {
    pub fn from_env() -> Device {
        match std::env::var("RINGTOME_DEVICE").as_deref() {
            Ok("phone") => Device::Phone,
            Ok("computer") => Device::Computer,
            _ => Device::Server,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Device::Server => "server",
            Device::Computer => "computer",
            Device::Phone => "phone",
        }
    }
}

/// A cache's share of the budget (the plan's split).
#[derive(Clone, Copy, Debug)]
pub enum Part {
    /// Each persona's doc-meta view (Stage 6).
    DocMeta,
    /// Public thumbnails and media, by hash (Stage 7).
    PublicBytes,
    /// Public posts' text and rendered pages (Stage 7).
    PublicText,
    /// Whole-table reads kept per persona (Stage 8).
    Tables,
}

impl Part {
    fn percent(self) -> u64 {
        match self {
            Part::DocMeta => 40,
            Part::PublicBytes => 25,
            Part::PublicText => 15,
            Part::Tables => 20,
        }
    }
}

const MB: u64 = 1024 * 1024;
const GB: u64 = 1024 * MB;
/// No budget below this, wherever the node runs - unless the operator says `0`.
const FLOOR: u64 = 32 * MB;

/// The budget and how it was arrived at - for the boot line.
#[derive(Clone, Debug)]
pub struct Budget {
    pub bytes: u64,
    pub device: Device,
    /// The machine's memory as the node sees it, when it can tell.
    pub total: Option<u64>,
    /// Said by `RINGTOME_CACHE_MEMORY`.
    pub overridden: bool,
}

static BUDGET: OnceLock<Budget> = OnceLock::new();

/// The budget: decided once, at the first ask (the boot calls `init` to say it out loud).
pub fn budget() -> &'static Budget {
    BUDGET.get_or_init(|| {
        let device = Device::from_env();
        let total = machine_memory();
        let said = std::env::var("RINGTOME_CACHE_MEMORY").ok();
        decide(device, total, said.as_deref())
    })
}

/// Decide the budget and say it - once, at boot.
pub fn init() {
    let b = budget();
    let how = if b.overridden {
        "RINGTOME_CACHE_MEMORY".to_string()
    } else {
        match b.total {
            Some(t) => format!("{}, {} memory", b.device.name(), size(t)),
            None => format!("{}, memory unknown", b.device.name()),
        }
    };
    tracing::info!(bytes = b.bytes, "cache budget {} ({how})", size(b.bytes));
}

/// A cache's share, in bytes.
pub fn share(part: Part) -> u64 {
    budget().bytes / 100 * part.percent()
}

/// The budget for a device and a machine, or what the operator said.
pub fn decide(device: Device, total: Option<u64>, said: Option<&str>) -> Budget {
    if let Some(said) = said.and_then(|s| parse(s, total)) {
        return Budget { bytes: said, device, total, overridden: true };
    }
    let bytes = match total {
        None => FLOOR,
        Some(total) => {
            let wanted = match device {
                // A quarter, leaving a gigabyte for everything else: the databases' page caches,
                // the transcodes, the OS's file cache - none of it counted here.
                Device::Server => (total / 4).min(total.saturating_sub(GB)),
                Device::Computer => (total / 20).min(GB),
                Device::Phone => (total / 50).min(256 * MB),
            };
            wanted.max(FLOOR)
        }
    };
    Budget { bytes, device, total, overridden: false }
}

/// `RINGTOME_CACHE_MEMORY`: `2GB`, `512MB`, `40%`, or a count of bytes; `0` is off.
fn parse(said: &str, total: Option<u64>) -> Option<u64> {
    let s = said.trim().to_ascii_uppercase();
    if let Some(p) = s.strip_suffix('%') {
        let p: u64 = p.trim().parse().ok()?;
        return total.map(|t| t / 100 * p.min(100));
    }
    let (n, unit) = match s.find(|c: char| !c.is_ascii_digit() && c != '.') {
        Some(i) => (&s[..i], s[i..].trim()),
        None => (s.as_str(), ""),
    };
    let n: f64 = n.parse().ok()?;
    let unit = match unit {
        "" | "B" => 1,
        "K" | "KB" => 1024,
        "M" | "MB" => MB,
        "G" | "GB" => GB,
        _ => return None,
    };
    Some((n * unit as f64) as u64)
}

fn size(bytes: u64) -> String {
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else {
        format!("{} MB", bytes / MB)
    }
}

/// The machine's memory as this process may use it: the tighter of the machine and a cgroup's
/// limit on Linux; the machine on macOS; unknown elsewhere.
fn machine_memory() -> Option<u64> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let machine = meminfo("MemTotal:");
        let limit = cgroup_limit();
        return match (machine, limit) {
            (Some(m), Some(l)) => Some(m.min(l)),
            (m, l) => m.or(l),
        };
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
        return String::from_utf8_lossy(&out.stdout).trim().parse().ok();
    }
    #[allow(unreachable_code)]
    None
}

/// A line of `/proc/meminfo`, in bytes.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn meminfo(field: &str) -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = text.lines().find(|l| l.starts_with(field))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

/// This process's cgroup memory limit (v2 `memory.max`, v1 `memory.limit_in_bytes`), if set.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn cgroup_limit() -> Option<u64> {
    for path in ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"] {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(n) = text.trim().parse::<u64>() {
                // v1 says "no limit" with a number near u64::MAX.
                if n < (1 << 60) {
                    return Some(n);
                }
            }
        }
    }
    None
}

/// What a cache does when memory runs short: drop what it holds.
type Shed = fn();
static SHEDS: Mutex<Vec<(&'static str, Shed)>> = Mutex::new(Vec::new());

/// A cache asks to be told when memory runs short.
pub fn on_pressure(name: &'static str, shed: Shed) {
    if let Ok(mut sheds) = SHEDS.lock() {
        if !sheds.iter().any(|(n, _)| *n == name) {
            sheds.push((name, shed));
        }
    }
}

/// Every cache that asked, told to drop what it holds.
pub fn shed_all(why: &str) {
    let sheds: Vec<(&'static str, Shed)> = SHEDS.lock().map(|s| s.clone()).unwrap_or_default();
    for (_, shed) in &sheds {
        shed();
    }
    tracing::warn!(caches = sheds.len(), "memory short ({why}): caches dropped");
}

/// The pressure beat: under a tenth of the total available, drop the caches. Where the machine
/// can't say what's available, nothing.
pub async fn pressure_pass(_state: crate::AppState) -> anyhow::Result<()> {
    if let (Some(total), Some(available)) = (budget().total, available_memory()) {
        if available < total / 10 {
            shed_all(&format!("{} of {} available", size(available), size(total)));
        }
    }
    Ok(())
}

fn available_memory() -> Option<u64> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let machine = meminfo("MemAvailable:");
        // Inside a cgroup, its own headroom.
        let headroom = cgroup_limit().and_then(|limit| {
            let used = std::fs::read_to_string("/sys/fs/cgroup/memory.current")
                .ok()?
                .trim()
                .parse::<u64>()
                .ok()?;
            Some(limit.saturating_sub(used))
        });
        return match (machine, headroom) {
            (Some(m), Some(h)) => Some(m.min(h)),
            (m, h) => m.or(h),
        };
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The plan's table, row by row - and Curtis's machines.
    #[test]
    fn the_budget_fits_the_machine() {
        let b = |d, t: u64| decide(d, Some(t), None).bytes;
        assert_eq!(b(Device::Server, 16 * GB), 4 * GB, "the server: a quarter");
        assert_eq!(b(Device::Computer, 16 * GB), 16 * GB / 20, "a computer: a twentieth");
        assert_eq!(b(Device::Computer, 64 * GB), GB, "...at most a gigabyte");
        assert_eq!(b(Device::Phone, 12 * GB), 12 * GB / 50, "the phone: a fiftieth");
        assert_eq!(b(Device::Phone, 32 * GB), 256 * MB, "...at most 256 MB");
        assert_eq!(b(Device::Server, GB), FLOOR, "a 1 GB VPS: the floor, leaving its gigabyte");
        assert_eq!(b(Device::Server, 2 * GB), 512 * MB);
        assert_eq!(b(Device::Phone, GB), FLOOR, "never under the floor");
        assert_eq!(decide(Device::Server, None, None).bytes, FLOOR, "memory unknown: the floor");
    }

    /// `RINGTOME_CACHE_MEMORY`: sizes, shares, off - and nonsense ignored.
    #[test]
    fn the_operator_can_say_otherwise() {
        let said = |s| decide(Device::Server, Some(16 * GB), Some(s));
        assert_eq!(said("2GB").bytes, 2 * GB);
        assert_eq!(said("512mb").bytes, 512 * MB);
        assert_eq!(said("40%").bytes, 16 * GB / 100 * 40);
        assert_eq!(said("0").bytes, 0, "off");
        assert!(said("0").overridden);
        let nonsense = said("lots");
        assert!(!nonsense.overridden && nonsense.bytes == 4 * GB, "nonsense: the default");
    }

    #[test]
    fn the_shares_add_up() {
        let total: u64 = [Part::DocMeta, Part::PublicBytes, Part::PublicText, Part::Tables]
            .iter()
            .map(|p| p.percent())
            .sum();
        assert_eq!(total, 100);
    }
}
