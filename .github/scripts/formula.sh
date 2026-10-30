#!/bin/sh
# Usage: formula.sh <version> <dir with uredu-<target>.tar.gz>  — prints the Homebrew formula.
set -eu
version=$1
dir=$2
base="https://github.com/lispberry/uredu/releases/download/v$version"
sum() { shasum -a 256 "$dir/uredu-$1.tar.gz" | cut -d' ' -f1; }
cat <<RUBY
class Uredu < Formula
  desc "Claim-gated workflows for coding agents: done means proven"
  homepage "https://github.com/lispberry/uredu"
  version "$version"

  on_macos do
    on_arm do
      url "$base/uredu-darwin-arm64.tar.gz"
      sha256 "$(sum darwin-arm64)"
    end
    on_intel do
      url "$base/uredu-darwin-x64.tar.gz"
      sha256 "$(sum darwin-x64)"
    end
  end

  on_linux do
    on_arm do
      url "$base/uredu-linux-arm64.tar.gz"
      sha256 "$(sum linux-arm64)"
    end
    on_intel do
      url "$base/uredu-linux-x64.tar.gz"
      sha256 "$(sum linux-x64)"
    end
  end

  def install
    bin.install "uredu"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/uredu --version")
  end
end
RUBY
