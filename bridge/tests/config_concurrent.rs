use agent_browser_bridge::config;
use std::{io::Write, process::{Command, Stdio}, time::{Duration, Instant}};

// Spawn the same library in independent processes, all released by a shared file barrier.
#[test]
fn first_initialization_is_consistent_across_processes() {
    let home = tempfile::tempdir().unwrap();
    let executable = std::env::current_exe().unwrap();
    let mut children = (0..16).map(|_| {
        Command::new(&executable)
            .args(["--exact", "initializer_child", "--ignored", "--nocapture"])
            .env("AB_CONFIG_TEST_HOME", home.path())
            .stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().unwrap()
    }).collect::<Vec<_>>();
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::fs::read_dir(home.path()).unwrap().filter_map(Result::ok).filter(|entry| entry.file_name().to_string_lossy().starts_with("ready-")).count() != children.len() {
        if Instant::now() >= deadline {
            for child in &mut children { let _ = child.kill(); let _ = child.wait(); }
            panic!("config child startup timed out");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    std::fs::File::create(home.path().join("start")).unwrap().write_all(b"start").unwrap();
    let outputs = children.into_iter().map(|child| child.wait_with_output().unwrap()).collect::<Vec<_>>();
    let published = config::load_or_init(home.path()).unwrap();
    for output in outputs {
        assert!(output.status.success(), "initializer failed: {}", String::from_utf8_lossy(&output.stderr));
        let text = String::from_utf8(output.stdout).unwrap();
        let token = text.lines().find_map(|line| line.strip_prefix("TOKEN:")).expect("child token result");
        assert!(config::tokens_equal(token, &published.token), "different processes observed different tokens");
    }
}

#[test]
#[ignore = "helper process for first_initialization_is_consistent_across_processes"]
fn initializer_child() {
    let home = std::path::PathBuf::from(std::env::var_os("AB_CONFIG_TEST_HOME").expect("helper-only environment"));
    std::fs::write(home.join(format!("ready-{}", std::process::id())), b"ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !home.join("start").exists() {
        assert!(Instant::now() < deadline, "parent barrier timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
    println!("TOKEN:{}", config::load_or_init(&home).unwrap().token);
}
