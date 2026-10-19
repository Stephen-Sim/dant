#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{io::{BufRead,BufReader,Write},path::PathBuf,process::{Child,Command,Stdio},sync::{Mutex,mpsc},time::Duration};
use tauri::Manager;
mod transport;
mod notifications;
mod speech;
mod downloads;
mod call_overlay;
mod tray;
mod text_editor;
mod updates;
mod update_helper;
#[cfg(windows)] use std::os::windows::process::CommandExt;
struct Backend(Mutex<Option<Child>>);
fn runtime_path(path:PathBuf)->PathBuf{
 #[cfg(windows)] {
  let value=path.to_string_lossy();
  if let Some(rest)=value.strip_prefix(r"\\?\UNC\"){return PathBuf::from(format!(r"\\{}",rest));}
  if let Some(rest)=value.strip_prefix(r"\\?\"){return PathBuf::from(rest);}
 }
 path
}
fn startup_error(message: &str){
 #[cfg(windows)] {
  #[link(name="user32")] extern "system" {fn MessageBoxW(hwnd:*mut std::ffi::c_void,text:*const u16,title:*const u16,kind:u32)->i32;}
  let text:Vec<u16>=message.encode_utf16().chain(Some(0)).collect();
  let title:Vec<u16>="dant".encode_utf16().chain(Some(0)).collect();
  unsafe{MessageBoxW(std::ptr::null_mut(),text.as_ptr(),title.as_ptr(),0x10);}
 }
 #[cfg(not(windows))] eprintln!("{message}");
}
fn main(){
 if update_helper::run_helper_mode(){return;}
 if update_helper::startup_fenced(){return;}
 let app=tauri::Builder::default()
 .plugin(tauri_plugin_single_instance::init(|app,_,_|tray::restore(app)))
 .plugin(tauri_plugin_notification::init())
 .plugin(tauri_plugin_opener::init())
 .plugin(tauri_plugin_dialog::init())
 .manage(speech::SpeechProcess::default())
 .manage(call_overlay::CallOverlay::default())
 .manage(tray::BackgroundTray::default())
 .manage(updates::Updates::default())
 .on_window_event(|window,event|{if !tray::on_window_event(window,event){call_overlay::on_window_event(window,event);}})
 .invoke_handler(tauri::generate_handler![transport::api_request,speech::speech_start,speech::speech_stop,downloads::save_attachment,call_overlay::call_overlay_update,call_overlay::call_overlay_get,call_overlay::call_overlay_action,call_overlay::call_overlay_drag,tray::tray_status_update,text_editor::editor_preferences,text_editor::installed_text_editors,text_editor::select_text_editor,text_editor::choose_text_editor,text_editor::reset_text_editor,text_editor::open_attachment_in_editor,updates::download_update,updates::install_update,updates::update_capabilities])
 .setup(|app|{
   call_overlay::setup(app);
   if tray::setup(app).is_err(){eprintln!("The system tray is unavailable; closing dant will exit normally.");}
   if transport::existing_controller(){app.manage(Backend(Mutex::new(None)));notifications::start(app);return Ok(());}
   let backend_root=runtime_path(if cfg!(debug_assertions){PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()}else{app.path().resource_dir()?.join("backend")});
   let data=runtime_path(if let Some(value)=std::env::var_os("DANT_DATA"){PathBuf::from(value)}else if cfg!(debug_assertions){backend_root.join("data")}else{app.path().app_data_dir()?.join("data")});
   std::fs::create_dir_all(&data)?;
   let node=if cfg!(debug_assertions){std::path::PathBuf::from("node")}else{backend_root.join("node.exe")};
   let mut command=Command::new(node);
   let mut log=std::fs::OpenOptions::new().create(true).append(true).open(data.join("startup.log"))?;
   writeln!(log,"Starting dant backend in {}",backend_root.display())?;
   command.arg("src/server.mjs").current_dir(&backend_root).env("DANT_DATA",&data).env("DANT_MANAGED","1").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(log));
   #[cfg(windows)] command.creation_flags(0x08000000);
   let mut child=command.spawn()?;
   let (sender,receiver)=mpsc::channel();
   let output=child.stdout.take().ok_or("Missing backend output")?;
   std::thread::spawn(move||{for line in BufReader::new(output).lines().map_while(Result::ok){if line=="dant listening at http://127.0.0.1:4317"{let _=sender.send(());}}});
   if receiver.recv_timeout(Duration::from_secs(15)).is_err(){let _=child.kill();let _=child.wait();return Err(format!("dant backend could not start. Close other dant instances and check {}",data.join("startup.log").display()).into());}
   app.manage(Backend(Mutex::new(Some(child))));
   notifications::start(app);
   Ok(())
 }).build(tauri::generate_context!());
 let app=match app{Ok(app)=>app,Err(error)=>{startup_error(&format!("Unable to start dant: {error}"));std::process::exit(1);}};
 app.run(|handle,event|{if let tauri::RunEvent::Exit=event {if let Some(pump)=handle.try_state::<notifications::NotificationPump>(){pump.0.store(false,std::sync::atomic::Ordering::Relaxed);}if let Some(process)=handle.try_state::<speech::SpeechProcess>(){speech::stop(&process);}if let Some(state)=handle.try_state::<Backend>(){if let Some(mut child)=state.0.lock().unwrap().take(){drop(child.stdin.take());for _ in 0..30{if child.try_wait().ok().flatten().is_some(){break;}std::thread::sleep(Duration::from_millis(100));}let _=child.kill();let _=child.wait();}}}});
}
