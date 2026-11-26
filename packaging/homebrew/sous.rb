# The Homebrew formula of sous. The release workflow fills in the version and the sha256 of the
# npm tarball, and pushes the result to AlexMaggioni/homebrew-tap as Formula/sous.rb.
class Sous < Formula
  desc "Run workflows of Claude Code and Codex agents in the background"
  homepage "https://github.com/AlexMaggioni/sous"
  url "https://registry.npmjs.org/@sous/cli/-/cli-{{version}}.tgz"
  sha256 "{{sha256}}"
  license "Apache-2.0"

  depends_on "node"

  def install
    # The Agent SDK's optional packages hold its own copy of Claude Code. sous runs the Claude
    # Code installed on the machine, so it never needs them.
    system "npm", "install", *std_npm_args, "--omit=optional"
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match "sous #{version}", shell_output("#{bin}/sous --version")
  end
end
