// DeskCal 맥 캘린더 도우미
// 맥에 이미 로그인된 계정(아이클라우드·구글 등)의 캘린더를 맥 기본 기능(EventKit)으로 읽고 씁니다.
// 앱 전용 암호가 필요 없고, 처음 한 번 '캘린더 접근 허용'만 하면 됩니다.
//
// 대화 방식: 한 줄에 JSON 하나씩
//   받음  {"id":1,"cmd":"events","from":"...","to":"...","calIds":[...]}
//   보냄  {"id":1,"ok":true,"result":...}  또는  {"id":1,"ok":false,"error":"..."}
//
// 빌드(맥): swiftc -swift-version 5 -O EventKitHelper.swift -o deskcal-eventkit

import Foundation
import EventKit
import CoreGraphics

setvbuf(stdout, nil, _IOLBF, 0)

let MEMO_NAME = "DeskCal 메모"
var store = EKEventStore()

struct HelperError: Error { let message: String }
func fail(_ m: String) -> HelperError { HelperError(message: m) }

func send(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj, options: []),
        let s = String(data: d, encoding: .utf8) else {
    print("{\"ok\":false,\"error\":\"응답을 만들지 못했습니다\"}")
    return
  }
  print(s)
  fflush(stdout)
}

// ---------- 날짜 ----------
let isoFrac: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()
let isoPlain = ISO8601DateFormatter()
func parseISO(_ s: String) -> Date? { isoFrac.date(from: s) ?? isoPlain.date(from: s) }
func isoString(_ d: Date) -> String { isoFrac.string(from: d) }

func dayKey(_ d: Date) -> String {
  let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
  return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
}
func dateFromKey(_ k: String) -> Date? {
  let p = k.split(separator: "-").compactMap { Int($0) }
  guard p.count == 3 else { return nil }
  return Calendar.current.date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
}

// ---------- 색 ----------
func hexColor(_ cg: CGColor?) -> String {
  guard let cg = cg, let srgb = CGColorSpace(name: CGColorSpace.sRGB),
        let c = cg.converted(to: srgb, intent: .defaultIntent, options: nil),
        let comps = c.components, comps.count >= 3 else { return "#8e8e93" }
  let r = Int((max(0, min(1, comps[0])) * 255).rounded())
  let g = Int((max(0, min(1, comps[1])) * 255).rounded())
  let b = Int((max(0, min(1, comps[2])) * 255).rounded())
  return String(format: "#%02x%02x%02x", r, g, b)
}

// ---------- 허용 ----------
func statusString() -> String {
  let s = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) {
    if s == .fullAccess { return "granted" }
    if s == .writeOnly { return "writeOnly" }
  }
  switch s {
  case .notDetermined: return "notDetermined"
  case .denied: return "denied"
  case .restricted: return "restricted"
  default: break
  }
  if s.rawValue == 3 { return "granted" } // 예전 맥의 '허용됨'
  return "unknown"
}

func requestAccess() -> Bool {
  let sem = DispatchSemaphore(value: 0)
  var granted = false
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { g, _ in granted = g; sem.signal() }
  } else {
    store.requestAccess(to: .event) { g, _ in granted = g; sem.signal() }
  }
  sem.wait()
  if granted { store = EKEventStore() } // 허용 직후 목록을 새로 읽도록
  return granted
}

func needAccess() throws {
  if statusString() != "granted" { throw fail("맥 캘린더 접근이 허용되지 않았습니다") }
}

// ---------- 캘린더 ----------
func calJSON(_ c: EKCalendar) -> [String: Any] {
  return [
    "id": c.calendarIdentifier,
    "name": c.title,
    "color": hexColor(c.cgColor),
    "writable": c.allowsContentModifications,
    "source": c.source?.title ?? "",
    "memo": c.title == MEMO_NAME,
  ]
}

func calendarsById(_ ids: [String]) -> [EKCalendar] {
  let set = Set(ids)
  return store.calendars(for: .event).filter { set.contains($0.calendarIdentifier) }
}

// ---------- 일정 ----------
func evJSON(_ e: EKEvent) -> [String: Any] {
  let start: Date = e.startDate
  let end: Date = e.endDate
  var o: [String: Any] = [
    "id": e.eventIdentifier ?? "",
    "uid": e.calendarItemExternalIdentifier ?? e.calendarItemIdentifier,
    "title": e.title ?? "",
    "allDay": e.isAllDay,
    "location": e.location ?? "",
    "notes": e.notes ?? "",
    "calId": e.calendar?.calendarIdentifier ?? "",
    "recurring": e.hasRecurrenceRules,
    "hasAlarm": e.hasAlarms,
    "writable": e.calendar?.allowsContentModifications ?? false,
    "start": isoString(start),
    "end": isoString(end),
  ]
  if e.isAllDay {
    let s = dayKey(start)
    var en = dayKey(end)
    if en < s { en = s }
    o["startDay"] = s
    o["endDay"] = en
  } else {
    let endForDay = max(start, end.addingTimeInterval(-1))
    o["startDay"] = dayKey(start)
    o["endDay"] = dayKey(endForDay)
  }
  return o
}

func fetchEvents(from: Date, to: Date, cals: [EKCalendar]) -> [EKEvent] {
  if cals.isEmpty { return [] }
  let pred = store.predicateForEvents(withStart: from, end: to, calendars: cals)
  return store.events(matching: pred)
}

// 화면에서 받은 일정 내용을 EKEvent에 넣기
func apply(_ ev: [String: Any], to e: EKEvent) throws {
  let title = (ev["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  if title.isEmpty { throw fail("일정 제목을 입력해 주세요") }
  e.title = title
  e.location = (ev["location"] as? String).flatMap { $0.isEmpty ? nil : $0 }
  e.notes = (ev["notes"] as? String).flatMap { $0.isEmpty ? nil : $0 }
  let allDay = ev["allDay"] as? Bool ?? false
  if allDay {
    guard let sk = ev["startDay"] as? String, let s = dateFromKey(sk) else { throw fail("날짜가 올바르지 않습니다") }
    let ek = ev["endDay"] as? String ?? sk
    guard let en = dateFromKey(ek), en >= s else { throw fail("끝 날짜가 시작 날짜보다 빠릅니다") }
    e.isAllDay = true
    e.startDate = s
    e.endDate = en.addingTimeInterval(86399) // 하루 종일 일정은 마지막 날 23:59:59까지
  } else {
    guard let ss = ev["start"] as? String, let s = parseISO(ss),
          let es = ev["end"] as? String, let en = parseISO(es) else { throw fail("시간이 올바르지 않습니다") }
    if en <= s { throw fail("끝 시간이 시작 시간보다 빠릅니다") }
    e.isAllDay = false
    e.startDate = s
    e.endDate = en
  }
  if ev.keys.contains("alarmMinutes") {
    if let m = ev["alarmMinutes"] as? Double, m >= 0 {
      e.alarms = [EKAlarm(relativeOffset: -m * 60)]
    } else {
      e.alarms = nil
    }
  }
}

func findEvent(_ id: String) throws -> EKEvent {
  guard let e = store.event(withIdentifier: id) else { throw fail("일정을 찾지 못했습니다. 새로고침 후 다시 시도해 주세요") }
  return e
}

// ---------- 월별 메모 ----------
func memoCalendar(create: Bool) throws -> EKCalendar? {
  if let c = store.calendars(for: .event).first(where: { $0.title == MEMO_NAME }) { return c }
  if !create { return nil }
  let c = EKCalendar(for: .event, eventStore: store)
  c.title = MEMO_NAME
  // 아이클라우드에 만들어야 윈도우와 함께 봄
  let icloud = store.sources.first { $0.sourceType == .calDAV && $0.title.lowercased().contains("icloud") }
  guard let src = icloud ?? store.defaultCalendarForNewEvents?.source ?? store.sources.first(where: { $0.sourceType == .local }) else {
    throw fail("메모를 저장할 캘린더 계정을 찾지 못했습니다")
  }
  c.source = src
  c.cgColor = CGColor(red: 0.557, green: 0.557, blue: 0.576, alpha: 1)
  do { try store.saveCalendar(c, commit: true) } catch { throw fail("메모 캘린더를 만들지 못했습니다: \(error.localizedDescription)") }
  return c
}

func monthFirst(_ month: String) throws -> Date {
  let p = month.split(separator: "-").compactMap { Int($0) }
  guard p.count == 2, (1...12).contains(p[1]),
        let d = Calendar.current.date(from: DateComponents(year: p[0], month: p[1], day: 1)) else { throw fail("달이 올바르지 않습니다") }
  return d
}

func memoEvent(_ month: String, in cal: EKCalendar) throws -> EKEvent? {
  let first = try monthFirst(month)
  let key = dayKey(first)
  let from = first.addingTimeInterval(-86400)
  let to = first.addingTimeInterval(2 * 86400)
  let list = fetchEvents(from: from, to: to, cals: [cal]).filter { dayKey($0.startDate) == key }
  // 같은 달 메모가 둘 이상이면 가장 최근에 고친 것
  return list.max { ($0.lastModifiedDate ?? .distantPast) < ($1.lastModifiedDate ?? .distantPast) }
}

func memoGet(_ month: String) throws -> [String: Any] {
  guard let cal = try memoCalendar(create: false), let e = try memoEvent(month, in: cal) else { return ["found": false] }
  let t = e.lastModifiedDate ?? e.creationDate ?? Date(timeIntervalSince1970: 0)
  return ["found": true, "text": e.notes ?? "", "updatedAt": (t.timeIntervalSince1970 * 1000).rounded()]
}

func memoSave(_ month: String, _ text: String) throws {
  let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  if empty {
    guard let cal = try memoCalendar(create: false), let e = try memoEvent(month, in: cal) else { return }
    try store.remove(e, span: .thisEvent, commit: true)
    return
  }
  guard let cal = try memoCalendar(create: true) else { throw fail("메모 캘린더를 만들지 못했습니다") }
  let first = try monthFirst(month)
  let m = Calendar.current.component(.month, from: first)
  let e = try memoEvent(month, in: cal) ?? EKEvent(eventStore: store)
  e.calendar = cal
  e.title = "📝 \(m)월 메모"
  e.isAllDay = true
  e.startDate = first
  e.endDate = first.addingTimeInterval(86399)
  e.notes = text
  e.availability = .free
  try store.save(e, span: .thisEvent, commit: true)
}

// ---------- 명령 처리 ----------
func handle(_ req: [String: Any]) throws -> Any {
  let cmd = req["cmd"] as? String ?? ""
  switch cmd {
  case "ping":
    return ["version": 1]
  case "status":
    return ["status": statusString()]
  case "request":
    if statusString() == "notDetermined" { _ = requestAccess() }
    return ["status": statusString()]
  case "calendars":
    try needAccess()
    return store.calendars(for: .event).map(calJSON)
  case "events":
    try needAccess()
    guard let fs = req["from"] as? String, let from = parseISO(fs),
          let ts = req["to"] as? String, let to = parseISO(ts) else { throw fail("기간이 올바르지 않습니다") }
    let cals = calendarsById(req["calIds"] as? [String] ?? [])
    return fetchEvents(from: from, to: to, cals: cals).map(evJSON)
  case "create":
    try needAccess()
    guard let calId = req["calId"] as? String, let cal = calendarsById([calId]).first else { throw fail("캘린더를 찾지 못했습니다") }
    guard cal.allowsContentModifications else { throw fail("이 캘린더에는 일정을 넣을 수 없습니다") }
    let e = EKEvent(eventStore: store)
    e.calendar = cal
    try apply(req["event"] as? [String: Any] ?? [:], to: e)
    do { try store.save(e, span: .thisEvent, commit: true) } catch { throw fail("저장하지 못했습니다: \(error.localizedDescription)") }
    return ["id": e.eventIdentifier ?? "", "uid": e.calendarItemExternalIdentifier ?? e.calendarItemIdentifier]
  case "update":
    try needAccess()
    let e = try findEvent(req["eventId"] as? String ?? "")
    if e.hasRecurrenceRules { throw fail("반복 일정은 아이폰이나 맥 캘린더에서 수정해 주세요") }
    try apply(req["event"] as? [String: Any] ?? [:], to: e)
    do { try store.save(e, span: .thisEvent, commit: true) } catch { throw fail("수정하지 못했습니다: \(error.localizedDescription)") }
    return ["id": e.eventIdentifier ?? ""]
  case "delete":
    try needAccess()
    let e = try findEvent(req["eventId"] as? String ?? "")
    do { try store.remove(e, span: .thisEvent, commit: true) } catch { throw fail("삭제하지 못했습니다: \(error.localizedDescription)") }
    return ["ok": true]
  case "memoGet":
    try needAccess()
    return try memoGet(req["month"] as? String ?? "")
  case "memoSave":
    try needAccess()
    try memoSave(req["month"] as? String ?? "", req["text"] as? String ?? "")
    return try memoGet(req["month"] as? String ?? "")
  case "refresh":
    store.refreshSourcesIfNecessary()
    return ["ok": true]
  default:
    throw fail("모르는 명령: \(cmd)")
  }
}

if CommandLine.arguments.contains("--version") {
  print("deskcal-eventkit 1")
  exit(0)
}
if CommandLine.arguments.contains("--status") {
  print(statusString())
  exit(0)
}

while let line = readLine(strippingNewline: true) {
  if line.isEmpty { continue }
  guard let data = line.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data, options: []),
        let req = obj as? [String: Any] else {
    send(["ok": false, "error": "요청을 읽지 못했습니다"])
    continue
  }
  let id = req["id"] ?? NSNull()
  do {
    let result = try handle(req)
    send(["id": id, "ok": true, "result": result])
  } catch let e as HelperError {
    send(["id": id, "ok": false, "error": e.message])
  } catch {
    send(["id": id, "ok": false, "error": error.localizedDescription])
  }
}
