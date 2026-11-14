//! Runs the shared rules cases (test/fixtures/rules-cases.json at the repository root, read at test time) against this
//! client's `decide`. The relay runs the same file in test/rules.test.js, and the Windows app runs `decide` in
//! test/app-native.cs, so the three cannot drift.
//!
//! Skipped: the two `decide` cases marked "scope":"relay". They say the relay compares short names (PROGRA~1) and
//! relative paths as plain strings because the PC expands them first. This client does not read them: a Mac has no
//! 8.3 short names, and a relative path is refused before the rules see it (files::absolute_path), so neither can
//! reach `decide` on the Mac in the form those cases test.

use serde_json::Value;
use support_core::rules::{decide, parse_doc, rules_tag, Action, Hours, Verdict};

fn cases() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/rules-cases.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("test/fixtures/rules-cases.json")).expect("valid JSON")
}

fn hours_of(c: &Value) -> Hours {
    let spans = c["hours_utc"].as_array().unwrap().iter().map(|p| (p[0].as_i64().unwrap(), p[1].as_i64().unwrap())).collect();
    Hours { spans, until: c["hours_until"].as_i64().unwrap() }
}

/// Runs every case of one array and returns how many ran and how many were skipped.
fn run(name: &str) -> (usize, usize) {
    let all = cases();
    let (mut ran, mut skipped) = (0, 0);
    for c in all[name].as_array().unwrap() {
        let label = c["name"].as_str().unwrap();
        if c["scope"] == "relay" {
            skipped += 1;
            continue;
        }
        let doc = parse_doc(&c["rules"]).unwrap_or_else(|| panic!("{name}: the case's rules do not parse: {label}"));
        let args = &c["args"];
        let delay = args["delay_s"].as_i64().unwrap_or(0);
        let what = Action { name: c["action"].as_str().unwrap(), program: args["program"].as_str(), path: args["path"].as_str(), delay_s: delay };
        let got = decide(&doc, &hours_of(c), c["now"].as_i64().unwrap(), args["control"].as_str().unwrap_or("full"), &what);
        let expect = &c["expect"];
        match expect["outcome"].as_str().unwrap() {
            "allow" => assert_eq!(got, Verdict::Allow, "{name}: {label}"),
            "approve" => assert_eq!(got, Verdict::Approve, "{name}: {label}"),
            "refuse" => match got {
                Verdict::Refuse { code, .. } => assert_eq!(code, expect["code"].as_str().unwrap(), "{name}: {label}"),
                other => panic!("{name}: {label}: expected a refusal, got {other:?}"),
            },
            other => panic!("unknown outcome {other}"),
        }
        ran += 1;
    }
    (ran, skipped)
}

#[test]
fn every_decide_case_but_the_relay_scope_ones_gives_the_relays_answer() {
    let (ran, skipped) = run("decide");
    assert_eq!(skipped, 2, "the fixture marks exactly two cases scope:relay");
    assert_eq!(ran, cases()["decide"].as_array().unwrap().len() - 2);
    assert!(ran >= 100, "ran {ran}");
}

#[test]
fn every_decide_posix_case_gives_the_relays_answer() {
    let (ran, skipped) = run("decide_posix");
    assert_eq!(skipped, 0);
    assert_eq!(ran, cases()["decide_posix"].as_array().unwrap().len());
    assert!(ran >= 20, "ran {ran}");
}

#[test]
fn the_tag_of_every_document_in_the_cases_matches_the_relays() {
    // vectors.json holds the tag src/rules.js makes for each distinct document in the cases, made by
    // tests/data/make-vectors.mjs.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/vectors.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let tags = v["tags"].as_array().unwrap();
    assert!(tags.len() > 5);
    for t in tags {
        assert_eq!(rules_tag(&t["doc"]), t["tag"].as_str().unwrap(), "{}", t["doc"]);
    }
}
