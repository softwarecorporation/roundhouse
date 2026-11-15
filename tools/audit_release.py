#!/usr/bin/env python3
"""Audit every Git history blob and current source without printing secret values."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("repository", nargs="?", type=Path, default=Path(__file__).resolve().parents[1])
parser.add_argument("--changes", action="store_true", help="Only current changed/untracked files; does not audit history")
args = parser.parse_args()
ROOT = args.repository.resolve()
PATTERNS = {
    "private_key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "github_token": re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b"),
    "provider_key": re.compile(rb"\bsk-(?:ant-[A-Za-z0-9_-]{35,}|[A-Za-z0-9]{40,})\b"),
    "aws_key": re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "credential_url": re.compile(rb"https?://[^\s/@:]+:[^\s/@]+@"),
}
SECRETS = {k: v.encode() for k, v in os.environ.items() if re.search(r"TOKEN|SECRET|PASSWORD|API_KEY", k) and len(v) >= 16}
findings = []
count = 0
fixtures = 0
# Exact, intentionally non-key upstream regression fixture, manually reviewed.
KEY_FIXTURE = b"-----BEGIN RSA " + b"PRIVATE KEY-----\\nMIIEpAIBAAKCAQEA...\\n-----END RSA PRIVATE KEY-----"

def scan(label, data):
    global count, fixtures
    count += 1
    fixtures += data.count(KEY_FIXTURE)
    candidate = data.replace(KEY_FIXTURE, b"DOCUMENTED_NON_KEY_FIXTURE")
    # Exact .test URL used to prove configuration rejects embedded credentials.
    candidate = candidate.replace(b"https://user:password@app.test/health", b"DOCUMENTED_NON_SECRET_URL_FIXTURE")
    for name, pattern in PATTERNS.items():
        if pattern.search(candidate):
            findings.append({"source": label, "rule": name})
    for name, value in SECRETS.items():
        if value in data:
            findings.append({"source": label, "rule": "environment_secret_literal", "variable": name})

objects = [] if args.changes else subprocess.check_output(["git", "rev-list", "--objects", "--all"], cwd=ROOT).splitlines()
for line in objects:
    oid = line.split(b" ", 1)[0]
    if subprocess.check_output(["git", "cat-file", "-t", oid], cwd=ROOT).strip() == b"blob":
        scan("git:" + line.decode(), subprocess.check_output(["git", "cat-file", "blob", oid], cwd=ROOT))
if args.changes:
    changed = subprocess.check_output(["git", "diff", "HEAD", "--name-only", "--diff-filter=ACMRT", "-z"], cwd=ROOT)
    untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=ROOT)
    files = set((changed + untracked).split(b"\0"))
else:
    files = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT).split(b"\0")
for file in files:
    if file:
        p = ROOT / file.decode()
        if p.is_file():
            scan("worktree:" + str(p.relative_to(ROOT)), p.read_bytes())
print(json.dumps({"scope": "current_changes_only" if args.changes else "history_and_worktree", "scanned_sources": count, "documented_non_key_fixtures": fixtures, "environment_values_checked": len(SECRETS), "findings": findings}, indent=2))
raise SystemExit(bool(findings))
