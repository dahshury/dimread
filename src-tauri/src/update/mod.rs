//! Update checking against the project's GitHub releases.
//!
//! DimRead does not ship the Tauri updater: that needs a minisign keypair and a
//! signed `latest.json` endpoint (see `bootstrap::plugins`), which the alpha
//! release pipeline deliberately does not produce. What the About tab CAN do
//! honestly is ask GitHub what the newest published release is and compare it
//! to the running build — so this module is a read-only query, never an
//! installer.
//!
//! Why the list endpoint and not `/releases/latest`: GitHub's "latest" excludes
//! pre-releases, and `release.yml` marks every version with a pre-release
//! segment (`0.0.2-alpha`) as one. Asking for `/releases/latest` on this repo
//! today returns 404. We list recent releases and pick the highest semver.
//!
//! The request runs in Rust, not the renderer, on purpose: the app's CSP pins
//! `connect-src` to `'self' ipc:`, so a `fetch("https://api.github.com/…")`
//! from the WebView would simply be blocked.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;

pub mod commands;

/// The project's repository. Every user-facing GitHub link in the app resolves
/// from here so a fork only has to edit one constant.
pub const REPO_URL: &str = "https://github.com/dahshury/dimread";

/// Where the About tab's "Releases" link points.
pub const RELEASES_URL: &str = "https://github.com/dahshury/dimread/releases";

/// Recent releases, newest first. `per_page=20` is far more than the number of
/// releases that can be newer than the running build, and keeps the response
/// small enough to parse in one shot.
const RELEASES_ENDPOINT: &str =
    "https://api.github.com/repos/dahshury/dimread/releases?per_page=20";

/// GitHub rejects unauthenticated API calls without a User-Agent.
const USER_AGENT: &str = concat!("DimRead/", env!("CARGO_PKG_VERSION"), " (update-check)");

/// Whole-request budget. A stalled check must fail fast enough that the button
/// does not look wedged; the user can always press it again.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How the running build compares to the newest published release.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    /// The running version matches the newest release.
    UpToDate,
    /// A newer release exists.
    UpdateAvailable,
    /// The running build is newer than anything published — a local dev build,
    /// or a release whose tag has not been pushed yet. Reported rather than
    /// rounded down to "up to date" so a tester can tell the two apart.
    Ahead,
}

/// The result of one update check.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub status: UpdateStatus,
    /// The running build's version, as compiled in.
    pub current_version: String,
    /// The newest published release's version, tag prefix stripped.
    pub latest_version: String,
    /// The release page, for "see what changed".
    pub release_url: String,
    /// The asset matching this OS/architecture, when the release has one.
    pub download_url: Option<String>,
    /// The asset's file name, so the UI can say what it is about to hand over.
    pub download_name: Option<String>,
    /// RFC 3339 publish timestamp, straight from GitHub.
    pub published_at: Option<String>,
}

/// One release as GitHub returns it. Only the fields we use.
#[derive(Clone, Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

/// The download the running platform should be offered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssetTarget {
    Windows,
    MacArm,
    MacIntel,
    Linux,
}

impl AssetTarget {
    /// The target this binary was compiled for. `None` on a platform the
    /// release pipeline does not build, in which case the UI links the release
    /// page instead of a file.
    pub fn current() -> Option<Self> {
        #[cfg(target_os = "windows")]
        {
            Some(Self::Windows)
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            Some(Self::MacArm)
        }
        #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
        {
            Some(Self::MacIntel)
        }
        #[cfg(target_os = "linux")]
        {
            Some(Self::Linux)
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            None
        }
    }

    /// Asset-name suffixes in preference order, mirroring the names
    /// `.github/workflows/release.yml` uploads. Lowercase — matching is
    /// case-insensitive.
    ///
    /// Windows leads with the bare `.exe` because that is the portable
    /// single-file build the README pushes people to; the `.zip` is the
    /// fallback. macOS is split by architecture and never falls back to a bare
    /// `.dmg`, so an Apple Silicon user is not handed the Intel disk image.
    fn suffixes(self) -> &'static [&'static str] {
        match self {
            Self::Windows => &["dimread.exe", "-portable.zip", ".exe"],
            Self::MacArm => &["_aarch64.dmg", "aarch64.dmg"],
            Self::MacIntel => &["x64-x86_64.dmg", "x86_64.dmg"],
            Self::Linux => &[".appimage", ".deb", ".rpm"],
        }
    }
}

/// Strip a leading `v`/`V` from a git tag so `v0.0.2-alpha` parses as semver.
fn tag_to_version(tag: &str) -> &str {
    tag.strip_prefix('v')
        .or_else(|| tag.strip_prefix('V'))
        .unwrap_or(tag)
}

/// The newest non-draft release with a parseable semver tag.
///
/// Pre-releases are included on purpose: DimRead's only published builds are
/// `-alpha`, so filtering them out would tell every user they are up to date
/// forever.
fn newest_release(releases: Vec<GithubRelease>) -> Option<(semver::Version, GithubRelease)> {
    releases
        .into_iter()
        .filter(|release| !release.draft)
        .filter_map(|release| {
            semver::Version::parse(tag_to_version(&release.tag_name))
                .ok()
                .map(|version| (version, release))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
}

/// The asset a given platform should download, or `None` when the release does
/// not carry one (an assetless release, or a platform we do not build).
fn pick_asset(assets: &[GithubAsset], target: Option<AssetTarget>) -> Option<&GithubAsset> {
    let target = target?;
    target.suffixes().iter().find_map(|suffix| {
        assets
            .iter()
            .find(|asset| asset.name.to_ascii_lowercase().ends_with(suffix))
    })
}

/// Compare the running version against a release listing.
fn compare(current: &semver::Version, latest: &semver::Version) -> UpdateStatus {
    match current.cmp(latest) {
        std::cmp::Ordering::Less => UpdateStatus::UpdateAvailable,
        std::cmp::Ordering::Equal => UpdateStatus::UpToDate,
        std::cmp::Ordering::Greater => UpdateStatus::Ahead,
    }
}

/// Turn a release listing plus the running version into the UI's answer.
/// Pure, so the whole decision is testable without a network.
fn resolve(
    current_version: &str,
    releases: Vec<GithubRelease>,
    target: Option<AssetTarget>,
) -> Result<UpdateCheck, String> {
    let current = semver::Version::parse(current_version)
        .map_err(|error| format!("unreadable app version `{current_version}`: {error}"))?;
    let (latest, release) =
        newest_release(releases).ok_or_else(|| "no published releases found".to_string())?;
    let asset = pick_asset(&release.assets, target);

    Ok(UpdateCheck {
        status: compare(&current, &latest),
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        release_url: if release.html_url.is_empty() {
            RELEASES_URL.to_string()
        } else {
            release.html_url.clone()
        },
        download_url: asset.map(|asset| asset.browser_download_url.clone()),
        download_name: asset.map(|asset| asset.name.clone()),
        published_at: release.published_at.clone(),
    })
}

/// Ask GitHub for recent releases and compare them to `current_version`.
pub async fn check(current_version: &str) -> Result<UpdateCheck, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("could not build the HTTP client: {error}"))?;

    let response = client
        .get(RELEASES_ENDPOINT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| format!("could not reach GitHub: {error}"))?;

    let status = response.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        // Unauthenticated GitHub API calls are capped per IP per hour. Say so
        // instead of reporting a generic failure the user cannot act on.
        return Err("GitHub rate limit reached — try again later".to_string());
    }
    if !status.is_success() {
        return Err(format!("GitHub returned HTTP {}", status.as_u16()));
    }

    // `bytes()` rather than `text()`: reqwest is built with
    // `default-features = false`, so the charset decoding `text()` needs is not
    // compiled in. The GitHub API is UTF-8 JSON regardless.
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("could not read GitHub's response: {error}"))?;
    let releases: Vec<GithubRelease> = serde_json::from_slice(&body)
        .map_err(|error| format!("could not parse GitHub's response: {error}"))?;

    resolve(current_version, releases, AssetTarget::current())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GithubAsset {
        GithubAsset {
            name: name.to_string(),
            browser_download_url: format!("https://example.test/{name}"),
        }
    }

    fn release(tag: &str, assets: Vec<GithubAsset>) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            html_url: format!("https://example.test/releases/{tag}"),
            draft: false,
            published_at: Some("2026-01-01T00:00:00Z".to_string()),
            assets,
        }
    }

    /// The shipping asset roster, exactly as `release.yml` uploads it.
    fn shipping_assets() -> Vec<GithubAsset> {
        vec![
            asset("DimRead.exe"),
            asset("DimRead-portable.zip"),
            asset("DimRead_0.0.2-alpha_aarch64.dmg"),
            asset("DimRead_0.0.2-alpha_x64-x86_64.dmg"),
            asset("DimRead_0.0.2-alpha_amd64.AppImage"),
            asset("DimRead_0.0.2-alpha_amd64.deb"),
            asset("DimRead-0.0.2-alpha-1.x86_64.rpm"),
        ]
    }

    #[test]
    fn strips_the_tag_prefix() {
        assert_eq!(tag_to_version("v0.0.2-alpha"), "0.0.2-alpha");
        assert_eq!(tag_to_version("V1.2.3"), "1.2.3");
        assert_eq!(tag_to_version("1.2.3"), "1.2.3");
    }

    #[test]
    fn a_prerelease_sorts_below_its_own_release() {
        // The whole reason the About tab can say "update available" for an
        // alpha user: 0.0.2-alpha must be older than 0.0.2.
        let alpha = semver::Version::parse("0.0.2-alpha").expect("valid semver");
        let final_release = semver::Version::parse("0.0.2").expect("valid semver");
        assert!(alpha < final_release);
        assert_eq!(
            compare(&alpha, &final_release),
            UpdateStatus::UpdateAvailable
        );
        assert_eq!(compare(&final_release, &alpha), UpdateStatus::Ahead);
        assert_eq!(compare(&alpha, &alpha.clone()), UpdateStatus::UpToDate);
    }

    #[test]
    fn picks_the_highest_version_not_the_first_listed() {
        let releases = vec![
            release("v0.0.2-alpha", vec![]),
            release("v0.1.0", vec![]),
            release("v0.0.9", vec![]),
        ];
        let (version, release) = newest_release(releases).expect("a release");
        assert_eq!(version.to_string(), "0.1.0");
        assert_eq!(release.tag_name, "v0.1.0");
    }

    #[test]
    fn skips_drafts_and_unparseable_tags() {
        let mut draft = release("v9.9.9", vec![]);
        draft.draft = true;
        let releases = vec![draft, release("nightly", vec![]), release("v0.2.0", vec![])];
        let (version, _) = newest_release(releases).expect("a release");
        assert_eq!(version.to_string(), "0.2.0");
    }

    #[test]
    fn no_releases_is_an_error_not_a_silent_up_to_date() {
        assert!(newest_release(vec![]).is_none());
        assert!(resolve("0.0.2-alpha", vec![], None).is_err());
    }

    #[test]
    fn every_platform_resolves_to_its_own_asset() {
        let assets = shipping_assets();
        let picked = |target| {
            pick_asset(&assets, Some(target))
                .map(|asset| asset.name.as_str())
                .expect("an asset for every shipped platform")
        };
        assert_eq!(picked(AssetTarget::Windows), "DimRead.exe");
        assert_eq!(
            picked(AssetTarget::MacArm),
            "DimRead_0.0.2-alpha_aarch64.dmg"
        );
        assert_eq!(
            picked(AssetTarget::MacIntel),
            "DimRead_0.0.2-alpha_x64-x86_64.dmg"
        );
        assert_eq!(
            picked(AssetTarget::Linux),
            "DimRead_0.0.2-alpha_amd64.AppImage"
        );
    }

    #[test]
    fn apple_silicon_is_never_handed_the_intel_image() {
        // An arm64 Mac with only an Intel .dmg on the release must fall through
        // to the release page, not download the wrong architecture.
        let intel_only = vec![asset("DimRead_0.0.2-alpha_x64-x86_64.dmg")];
        assert!(pick_asset(&intel_only, Some(AssetTarget::MacArm)).is_none());
    }

    #[test]
    fn an_assetless_release_still_resolves() {
        let check = resolve(
            "0.0.2-alpha",
            vec![release("v0.3.0", vec![])],
            Some(AssetTarget::Windows),
        )
        .expect("a check");
        assert_eq!(check.status, UpdateStatus::UpdateAvailable);
        assert_eq!(check.latest_version, "0.3.0");
        assert_eq!(check.download_url, None);
        assert_eq!(check.download_name, None);
        assert_eq!(check.release_url, "https://example.test/releases/v0.3.0");
    }

    #[test]
    fn resolves_a_full_check_for_the_current_release() {
        let check = resolve(
            "0.0.2-alpha",
            vec![release("v0.0.2-alpha", shipping_assets())],
            Some(AssetTarget::Linux),
        )
        .expect("a check");
        assert_eq!(check.status, UpdateStatus::UpToDate);
        assert_eq!(check.current_version, "0.0.2-alpha");
        assert_eq!(check.latest_version, "0.0.2-alpha");
        assert_eq!(
            check.download_name.as_deref(),
            Some("DimRead_0.0.2-alpha_amd64.AppImage")
        );
        assert_eq!(check.published_at.as_deref(), Some("2026-01-01T00:00:00Z"));
    }

    #[test]
    fn an_unreadable_app_version_is_reported() {
        assert!(resolve("not-a-version", vec![release("v1.0.0", vec![])], None).is_err());
    }

    #[test]
    fn parses_a_real_shaped_github_payload() {
        // Trimmed from the real `GET /repos/{owner}/{repo}/releases` shape,
        // extra fields included so `serde` ignoring them stays covered.
        let payload = r#"[
            {
              "tag_name": "v0.0.2-alpha",
              "name": "v0.0.2-alpha",
              "html_url": "https://github.com/dahshury/dimread/releases/tag/v0.0.2-alpha",
              "draft": false,
              "prerelease": true,
              "published_at": "2026-01-05T12:00:00Z",
              "assets": [
                {
                  "name": "DimRead.exe",
                  "size": 12345,
                  "browser_download_url": "https://github.com/dahshury/dimread/releases/download/v0.0.2-alpha/DimRead.exe"
                }
              ]
            }
        ]"#;
        let releases: Vec<GithubRelease> = serde_json::from_str(payload).expect("valid payload");
        let check = resolve("0.0.1-alpha", releases, Some(AssetTarget::Windows)).expect("a check");
        assert_eq!(check.status, UpdateStatus::UpdateAvailable);
        assert_eq!(
            check.download_url.as_deref(),
            Some("https://github.com/dahshury/dimread/releases/download/v0.0.2-alpha/DimRead.exe")
        );
    }

    #[test]
    fn the_repo_constants_agree() {
        assert!(RELEASES_URL.starts_with(REPO_URL));
        assert!(RELEASES_ENDPOINT.contains("dahshury/dimread"));
    }

    /// The only test that touches the network, so it is opt-in:
    /// `cargo test -- --ignored live_check_reaches_github`.
    /// Run it after changing the endpoint, the headers, or the release asset
    /// names — everything else here works off fixtures.
    #[test]
    #[ignore = "hits api.github.com"]
    fn live_check_reaches_github() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a tokio runtime");
        let check = runtime
            .block_on(check(env!("CARGO_PKG_VERSION")))
            .expect("the live check to succeed");
        assert!(!check.latest_version.is_empty());
        assert!(check.release_url.starts_with(REPO_URL));
    }
}
