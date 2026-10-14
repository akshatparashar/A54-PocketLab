#!/data/data/com.termux/files/usr/bin/bash
#
# PocketLab one-time phone setup (Termux).
#
#   curl -fsSL https://raw.githubusercontent.com/akshatparashar/A54-PocketLab/main/scripts/termux/install.sh | bash
#
# - installs nodejs, git, openssh, termux-api, curl, procps
# - puts the repository at ~/pocketlab (an older non-git ~/pocketlab is moved
#   to ~/pocketlab.backup-<date>; cv-history.json is carried over)
# - installs server dependencies
# - enables autostart: opening Termux or logging in over SSH starts sshd,
#   the server and the IoT agent; a 15-minute job restarts anything Android kills
# - adds the `pocketlab` command
#
# Safe to run again; it updates in place.

set -e

# Everything runs inside main(), which bash reads completely before running it.
# This matters for `curl ... | bash`: some Termux:API tools read standard input
# and would otherwise swallow the rest of this script.
main() {

    REPO_URL="${POCKETLAB_REPO:-https://github.com/akshatparashar/A54-PocketLab.git}"
    TARGET="${POCKETLAB_HOME:-$HOME/pocketlab}"

    say() { printf '\n\033[36m> %s\033[0m\n' "$*"; }

    say "Installing packages"
    need=()
    for pair in node:nodejs git:git sshd:openssh termux-battery-status:termux-api curl:curl pgrep:procps; do
        cmd="${pair%%:*}"
        pkg_name="${pair##*:}"
        command -v "$cmd" >/dev/null 2>&1 || need+=("$pkg_name")
    done
    if [ "${#need[@]}" -gt 0 ]; then
        pkg install -y "${need[@]}"
    else
        echo "All packages already installed."
    fi

    say "Getting PocketLab into $TARGET"
    if [ -d "$TARGET/.git" ]; then
        git -C "$TARGET" fetch origin
        upstream="$(git -C "$TARGET" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo origin/main)"
        backup="$TARGET.backup-$(date +%Y%m%d-%H%M%S)"
        moved=0

        # Files you created by hand that the new version also contains (untracked
        # in your copy) would block the update: move them to a backup folder.
        while IFS= read -r file; do
            if [ -e "$TARGET/$file" ] && ! git -C "$TARGET" ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
                mkdir -p "$backup/$(dirname "$file")"
                mv "$TARGET/$file" "$backup/$file"
                moved=1
            fi
        done < <(git -C "$TARGET" ls-tree -r --name-only "$upstream")

        # An old dashboard copy inside server/ is replaced by the top-level dashboard/.
        if [ -d "$TARGET/server/dashboard" ] && [ -z "$(git -C "$TARGET" ls-files -- server/dashboard)" ]; then
            mkdir -p "$backup/server"
            mv "$TARGET/server/dashboard" "$backup/server/dashboard"
            moved=1
        fi

        [ "$moved" = 1 ] && echo "Moved your old copies of the PocketLab files to $backup"

        if ! git -C "$TARGET" merge --ff-only "$upstream"; then
            echo
            echo "Could not update $TARGET automatically (you have local edits to tracked files)."
            echo "Run:  git -C $TARGET stash   and then run this installer again."
            exit 1
        fi
    else
        if [ -d "$TARGET" ]; then
            backup="$TARGET.backup-$(date +%Y%m%d-%H%M%S)"
            echo "Moving the existing $TARGET to $backup"
            # Stop the old processes before moving their files.
            pkill -f "pocketlab/iot/telemetry-agent\.sh" 2>/dev/null || true
            pkill -f "node .*pocketlab/server/server\.js" 2>/dev/null || true
            mv "$TARGET" "$backup"
        fi
        git clone --depth 1 "$REPO_URL" "$TARGET"
        if [ -n "${backup:-}" ] && [ -f "$backup/server/cv-history.json" ]; then
            cp "$backup/server/cv-history.json" "$TARGET/server/cv-history.json"
            echo "Kept your gesture history (cv-history.json)."
        fi
    fi

    chmod +x "$TARGET"/bin/* "$TARGET"/iot/*.sh "$TARGET"/server/*.sh "$TARGET"/ssh/*.sh "$TARGET"/scripts/termux/*.sh

    say "Installing server dependencies"
    (cd "$TARGET/server" && npm install --omit=dev --no-audit --no-fund)

    say "Adding the pocketlab command"
    ln -sf "$TARGET/bin/pocketlab" "$PREFIX/bin/pocketlab"
    echo "Installed: $PREFIX/bin/pocketlab"

    say "Enabling autostart"
    "$TARGET/bin/pocketlab" autostart enable

    say "Starting PocketLab"
    "$TARGET/bin/pocketlab" restart

    cat <<'EOF'

Done. From now on:
  phone : open Termux (sshd, server and agent start by themselves)
  laptop: ssh pocketlab

Recommended once on the phone:
  - Install the Termux:API app (same source as Termux) for battery/Wi-Fi/vibrate.
  - Settings > Battery > Termux: allow background activity / don't optimise.
  - Optional: install Termux:Boot to start PocketLab after a reboot.

Useful commands: pocketlab status | pocketlab logs server -f | pocketlab doctor
EOF
}

main "$@" < /dev/null
