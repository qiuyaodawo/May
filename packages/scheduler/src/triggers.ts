import { CronExpressionParser, type CronExpression } from "cron-parser";
import { DateTime, IANAZone } from "luxon";

import type { Trigger } from "./types.js";

export function validateTrigger(trigger: Trigger): void {
  if (trigger === null || typeof trigger !== "object") {
    throw new TypeError("trigger must be an object");
  }
  switch (trigger.type) {
    case "at": {
      requireKeys(trigger, ["type", "time"]);
      if (typeof trigger.time !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(trigger.time)) {
        throw new TypeError("at.time must be an ISO timestamp with an explicit UTC offset");
      }
      if (!DateTime.fromISO(trigger.time, { setZone: true }).isValid) {
        throw new TypeError("at.time must be a valid ISO timestamp");
      }
      break;
    }
    case "cron": {
      requireKeys(trigger, ["type", "expression", "timezone"]);
      if (typeof trigger.expression !== "string" || trigger.expression.trim().split(/\s+/).length !== 5) {
        throw new TypeError("cron.expression must contain exactly five fields");
      }
      if (/\bH(?=$|[(/,\s-])/i.test(trigger.expression)) {
        throw new TypeError("cron.expression does not support randomized H fields");
      }
      if (typeof trigger.timezone !== "string" || !IANAZone.isValidZone(trigger.timezone)) {
        throw new TypeError("cron.timezone must be a valid IANA timezone");
      }
      nextTime(trigger, Date.now());
      break;
    }
    case "event": {
      requireKeys(trigger, ["type", "topic"]);
      if (typeof trigger.topic !== "string" || trigger.topic.length > 256
        || trigger.topic.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(trigger.topic)) {
        throw new TypeError("event.topic must contain 1-256 characters without control characters and cannot be blank");
      }
      break;
    }
    default:
      throw new TypeError("Unknown trigger type");
  }
}

export function nextTime(trigger: Trigger, after: number): string | undefined {
  if (trigger.type === "event") return undefined;
  if (trigger.type === "at") {
    const time = DateTime.fromISO(trigger.time, { setZone: true }).toMillis();
    return time > after ? new Date(time).toISOString() : undefined;
  }
  const expression = parseCron(trigger, after);
  for (let attempts = 0; attempts < 1_000; attempts++) {
    const candidate = expression.next().toDate();
    if (!expression.includesDate(candidate)) continue;
    const time = firstLocalOccurrence(candidate.getTime(), trigger.timezone);
    if (time > after) return new Date(time).toISOString();
  }
  throw new RangeError("cron.expression has no valid next occurrence");
}

export function latestTime(trigger: Trigger, after: number, now: number): string | undefined {
  if (trigger.type === "event") return undefined;
  if (trigger.type === "at") {
    const time = DateTime.fromISO(trigger.time, { setZone: true }).toMillis();
    return time > after && time <= now ? new Date(time).toISOString() : undefined;
  }
  const expression = parseCron(trigger, now + 1);
  for (let attempts = 0; attempts < 1_000; attempts++) {
    const candidate = expression.prev().toDate();
    if (!expression.includesDate(candidate)) continue;
    const time = firstLocalOccurrence(candidate.getTime(), trigger.timezone);
    if (time <= after) return undefined;
    if (time <= now) return new Date(time).toISOString();
  }
  throw new RangeError("cron.expression has no valid previous occurrence");
}

function parseCron(trigger: Extract<Trigger, { type: "cron" }>, currentDate: number): CronExpression {
  return CronExpressionParser.parse(trigger.expression, {
    currentDate,
    tz: trigger.timezone,
    hashSeed: `${trigger.expression}:${trigger.timezone}`,
  });
}

function firstLocalOccurrence(time: number, timezone: string): number {
  // 重复的本地时间统一使用第一次出现的时刻。
  const possibilities = DateTime.fromMillis(time, { zone: timezone }).getPossibleOffsets();
  return Math.min(...possibilities.map((possibility) => possibility.toMillis()));
}

function requireKeys(value: object, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new TypeError("trigger contains an unsupported property");
  }
}
