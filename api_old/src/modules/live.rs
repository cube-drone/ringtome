use std::sync::Arc;
use anyhow::{Result, anyhow};
use uuid::Uuid;
use serde::{Serialize, Deserialize};
use std::collections::HashSet;
use papaya::HashMap as PapayaHashMap;
use tokio::sync::Mutex;

use crate::event::{Event, EventListener};
use crate::service_registry::ServiceRegistry;

pub mod view;
pub mod routes;

// okay, so here's how the live service works:
//  * clients are associated with a user account, but there can be multiple clients per user
//  * when a client "connects", we save the connection timestamp and give the client a connection ID (UUID)
//  * when something worth notifying the user about happens, we put that into the bin for every "connected" client
//  * if the client asks for updates and we don't have a connection for that user, we return an error and the client has to reconnect
//      * (if the server reboots or restarts, all connections are lost and clients have to reconnect)
//  * updates are just a list of "dirty" systems that the client should refresh
//      * so we don't pass along individual data, just "something changed in the messages system, refresh your message list"
//      * this means that if multiple things change in the same system, we only notify once
//  * if the client asks for updates and we do have a connection, we return all events that happened since the last time the client asked
//      * if the client hasn't asked for updates in a while (e.g. 5 minutes), we drop the connection and the client has to reconnect
//  * the live service can check if users are online by checking if they have a "connected" client
//  * the live service can be accessed either through a REST endpoint or through a WebSocket connection
//      * if websocket connections fail, clients can fall back to the REST endpoint

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum LiveEvent {
    MessagesChanged,
    // more to come
    ChannelChanged(Uuid), // channel ID
}

#[derive(Debug, Clone)]
pub struct Connection {
    pub id: Uuid,
    pub user_id: Uuid,
    pub _connected_at: chrono::DateTime<chrono::Utc>,
    pub last_polled_at: chrono::DateTime<chrono::Utc>,
    pub events: HashSet<LiveEvent>,
}

impl Connection {
    pub fn new(user_id: Uuid) -> Self {
        Self {
            id: Uuid::new_v4(),
            user_id,
            _connected_at: chrono::Utc::now(),
            last_polled_at: chrono::Utc::now(),
            events: HashSet::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Connections{
    pub connections: PapayaHashMap<Uuid, Arc<Mutex<Connection>>>, // key is connection ID
    pub user_connections: PapayaHashMap<Uuid, Arc<Mutex<HashSet<Uuid>>>>, // key is user ID, value is set of connection IDs
}

impl Connections {
    pub fn new() -> Self {
        Self {
            connections: PapayaHashMap::new(),
            user_connections: PapayaHashMap::new(),
        }
    }

    pub async fn create_connection(&self, user_id: &Uuid) -> Connection {
        let connection = Connection::new(user_id.clone());
        let id = connection.id;

        let connection_copy = connection.clone();

        // add the connection to the connections map
        let arc_conn = Arc::new(Mutex::new(connection));
        let conns = self.connections.pin_owned();
        conns.insert(id, arc_conn.clone());

        // add the connection ID to the user's set of connections
        let user_conns = self.user_connections.pin_owned();
        let user_mutex = user_conns.get(user_id);
        // if the user doesn't have any connections yet, create a new set
        let user_mutex = match user_mutex {
            Some(mutex) => mutex.clone(),
            None => {
                let new_set = Arc::new(Mutex::new(HashSet::new()));
                user_conns.insert(user_id.clone(), new_set.clone());
                new_set
            }
        };
        // lock the set and add the connection ID
        let mut user_conn_set = user_mutex.lock().await;
        user_conn_set.insert(id);

        connection_copy
    }

    pub async fn remove_connection(&self, connection_id: &Uuid) {
        let connection = self.get_connection(connection_id).await;
        if connection.is_none() {
            return;
        }
        let user_id = connection.unwrap().user_id.clone();

        let conns = self.connections.pin_owned();
        conns.remove(connection_id);

        // also remove from user_connections
        let user_conns = self.user_connections.pin_owned();
        let user_conns_mutex = user_conns.get(&user_id);
        if let Some(user_conns_mutex) = user_conns_mutex {
            let mut user_conn_set = user_conns_mutex.lock().await;
            user_conn_set.remove(connection_id);
        }
    }

    pub async fn get_connection(&self, connection_id: &Uuid) -> Option<Connection> {
        let conns = self.connections.pin_owned();
        let connection_mutex = conns.get(connection_id)?;
        let connection = connection_mutex.lock().await;
        Some(connection.clone())
    }

    pub async fn get_and_clear_events(&self, connection_id: &Uuid) -> Result<Vec<LiveEvent>> {
        let conns = self.connections.pin_owned();
        let connection_mutex = conns.get(connection_id).ok_or(anyhow!("Connection not found"))?;
        let mut connection = connection_mutex.lock().await;
        let events = connection.events.clone();
        // clear the events
        connection.events.clear();
        // update last polled time
        connection.last_polled_at = chrono::Utc::now();
        Ok(events.into_iter().collect())
    }

    pub async fn add_event_to_connection(&self, connection_id: &Uuid, event: LiveEvent) -> Result<()> {
        let conns = self.connections.pin_owned();
        let connection_mutex = conns.get(connection_id).ok_or(anyhow!("Connection not found"))?;
        let mut connection = connection_mutex.lock().await;
        connection.events.insert(event);
        Ok(())
    }

    pub async fn add_event_to_user(&self, user_id: &Uuid, event: LiveEvent) -> Result<()> {
        let user_conns = self.user_connections.pin_owned();
        let user_conns_mutex = user_conns.get(user_id);
        if user_conns_mutex.is_none() {
            return Ok(()); // user has no connections, nothing to do
        }
        let user_conns_mutex = user_conns_mutex.unwrap();
        let user_conn_set = user_conns_mutex.lock().await;
        for connection_id in user_conn_set.iter() {
            self.add_event_to_connection(connection_id, event.clone()).await?;
        }
        Ok(())
    }

    pub async fn destroy_all_user_connections(&self, user_id: &Uuid) {
        let user_conns = self.user_connections.pin_owned();
        let user_conns_mutex = user_conns.get(user_id);
        if user_conns_mutex.is_none() {
            return; // user has no connections, nothing to do
        }
        let user_conns_mutex = user_conns_mutex.unwrap();
        let user_conn_set = user_conns_mutex.lock().await;
        let connection_ids: Vec<Uuid> = user_conn_set.iter().cloned().collect();
        drop(user_conn_set); // release the lock before removing connections
        for connection_id in connection_ids {
            self.remove_connection(&connection_id).await;
        }
        // finally, remove the user's entry from user_connections
        user_conns.remove(user_id);
    }

    pub async fn destroy_stale_connections(&self, max_idle_duration: chrono::Duration) {
        let now = chrono::Utc::now();
        let conns = self.connections.pin_owned();
        let connection_ids: Vec<Uuid> = conns.iter().map(|(id, _)| id.clone()).collect();
        for connection_id in connection_ids {
            let connection_mutex = conns.get(&connection_id);
            if connection_mutex.is_none() {
                continue;
            }
            let connection_mutex = connection_mutex.unwrap();
            let connection = connection_mutex.lock().await;
            let idle_duration = now.signed_duration_since(connection.last_polled_at);
            if idle_duration > max_idle_duration {
                drop(connection); // release the lock before removing
                self.remove_connection(&connection_id).await;
            }
        }
    }
}


#[derive(Clone)]
pub struct LiveService {
    _config: crate::app_config::Config,
    _registry: Arc<dyn ServiceRegistry>,
    connections: Arc<Connections>,
}

impl LiveService {
    pub async fn new(config: crate::app_config::Config, registry: Arc<dyn ServiceRegistry>) -> Result<Self> {
        Ok(Self { _config: config, _registry: registry, connections: Arc::new(Connections::new()) })
    }

    pub async fn create_connection(&self, user_id: &Uuid) -> Result<Uuid> {
        let connection = self.connections.create_connection(user_id).await;
        Ok(connection.id)
    }

    pub async fn get_and_clear_events(&self, connection_id: &Uuid) -> Result<Vec<LiveEvent>> {
        self.connections.get_and_clear_events(connection_id).await
    }
}

impl EventListener for LiveService {
    async fn on_event(&self, event: crate::event::EventEnvelope) -> Result<()> {
        if event.user_id.is_none() {
            return Ok(()); // no user ID, nothing to do
        }
        let user_id = event.user_id.unwrap();

        match event.event {
            Event::FiveMinutely {  } => {
                // clean up stale connections
                self.connections.destroy_stale_connections(chrono::Duration::minutes(5)).await;
            },
            Event::UserReceiveMessage { from: _, message_id: _ } => {
                if event.user_id.is_none() {
                    return Ok(()); // no user ID, nothing to do
                }
                self.connections.add_event_to_user(&user_id, LiveEvent::MessagesChanged).await?;
            },
            Event::UserSeeMessage { message_id: _message_id } => {
                if event.user_id.is_none() {
                    return Ok(()); // no user ID, nothing to do
                }
                self.connections.add_event_to_user(&user_id, LiveEvent::MessagesChanged).await?;
            },
            Event::UserLogout { .. } => {
                self.connections.destroy_all_user_connections(&user_id).await;
            },
            Event::UserDeleted { .. } => {
                self.connections.destroy_all_user_connections(&user_id).await;
            },
            _ => {}
        }

        Ok(())
    }
}
