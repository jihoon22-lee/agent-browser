use agent_browser_bridge::{config, rpc::{Envelope, parse_envelope}, server::{conn::ServerState, router}};
use serde_json::json;
use std::sync::Arc;
#[tokio::test]
async fn snapshot_cursors_reach_the_extension_instead_of_being_dropped() {
 let home=tempfile::tempdir().unwrap();let cfg=config::load_or_init(home.path()).unwrap();
 let state=Arc::new(ServerState::new(home.path().to_owned(),cfg));
 let (tx,mut rx)=tokio::sync::mpsc::unbounded_channel();let conn=state.registry.register("test-profile",tx);
 let op=state.ops.attach(1,"test-profile").unwrap();let cloned=state.clone();
 let request=tokio::spawn(async move{router::call_tool(&cloned,"browser_snapshot",json!({"operationId":op.id,"elementOffset":150,"frameOffset":2})).await});
 let Envelope::Req{id,params,..}=parse_envelope(&rx.recv().await.unwrap()).unwrap() else {panic!("command expected")};
 state.registry.handle_response(conn,Envelope::ok(id,json!({"frames":[]})));
 assert_eq!(params["elementOffset"],150);assert_eq!(params["frameOffset"],2);
 assert!(request.await.unwrap().ok);
}
