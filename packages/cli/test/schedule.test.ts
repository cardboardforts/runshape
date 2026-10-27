/**
 * The nightly run (case 1): a launchd job that runs review-requests at a set time. Printed for
 * the person to install, never written into ~/Library by runshape: it changes what their
 * machine does at 3am, so they put it there. A Mac asleep at that time runs it on waking.
 */
import { expect, test } from "vitest";

import { launchdJob, scheduleInstructions } from "../src/schedule";

test("a launchd job: review-requests --explain at the set time, from the project, its output kept in a log", () => {
  const job = launchdJob({ root: "/Users/me/code/shop", at: "03:00", path: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" });

  expect(job).toMatchInlineSnapshot(`
    "<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>Label</key><string>com.runshape.review-requests</string>
      <key>ProgramArguments</key>
      <array><string>/bin/sh</string><string>-c</string><string>cd '/Users/me/code/shop' &amp;&amp; mkdir -p .runshape/reviews &amp;&amp; npm run --silent runshape -- review-requests --explain &gt;&gt; .runshape/reviews/nightly.log 2&gt;&amp;1</string></array>
      <key>EnvironmentVariables</key>
      <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
      <key>StartCalendarInterval</key>
      <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
    </dict>
    </plist>
    "
  `);
});

test("the instructions say where to put it and how to start it, and --at must be a time", () => {
  expect(scheduleInstructions("/Users/me/code/shop")).toEqual([
    "Save the job above as ~/Library/LaunchAgents/com.runshape.review-requests.plist, then:",
    "  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.runshape.review-requests.plist",
    "Its output goes to /Users/me/code/shop/.runshape/reviews/nightly.log, and its log (logfmt: each PR's outcome, time and error, by run=) to /Users/me/code/shop/.runshape/logs/runshape.log. To stop it:",
    "  launchctl bootout gui/$(id -u)/com.runshape.review-requests",
    "It records in Docker: Docker Desktop has to be running (its settings can start it at login).",
    "Install it from a clone kept for it: it runs this checkout's runshape, so not one where someone's PR may be checked out.",
  ]);
  expect(() => launchdJob({ root: "/r", at: "25:00", path: "/bin" })).toThrowError("--at takes a time of day, like 03:00");
});
