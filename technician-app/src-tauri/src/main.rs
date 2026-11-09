// A release build is a Windows program with no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    technician_app::run();
}
