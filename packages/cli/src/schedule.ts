// The nightly review-requests run as a launchd job (macOS), printed for the person to install.

export const JOB_LABEL = "com.runshape.review-requests";

export interface ScheduleOptions {
  /** The project: the job runs from here. */
  root: string;
  /** "HH:MM", local time. */
  at: string;
  /** launchd starts jobs with a bare PATH: node, git, gh and docker must be on this one. */
  path: string;
}

export function launchdJob({ root, at, path }: ScheduleOptions): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (match === null) throw new Error("--at takes a time of day, like 03:00");
  const [, hour, minute] = match;
  // The log's folder may not exist before the first review.
  const command = `cd ${shellQuoted(root)} && mkdir -p .runshape/reviews && npm run --silent runshape -- review-requests --explain >> .runshape/reviews/nightly.log 2>&1`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${JOB_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    `  <array><string>/bin/sh</string><string>-c</string><string>${xml(command)}</string></array>`,
    "  <key>EnvironmentVariables</key>",
    `  <dict><key>PATH</key><string>${xml(path)}</string></dict>`,
    "  <key>StartCalendarInterval</key>",
    `  <dict><key>Hour</key><integer>${Number(hour)}</integer><key>Minute</key><integer>${Number(minute)}</integer></dict>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function scheduleInstructions(root: string): string[] {
  const file = `~/Library/LaunchAgents/${JOB_LABEL}.plist`;
  return [
    `Save the job above as ${file}, then:`,
    `  launchctl bootstrap gui/$(id -u) ${file}`,
    `Its output goes to ${root}/.runshape/reviews/nightly.log. To stop it:`,
    `  launchctl bootout gui/$(id -u)/${JOB_LABEL}`,
    "It records in Docker: Docker Desktop has to be running (its settings can start it at login).",
  ];
}

function shellQuoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
