use std::sync::Arc;
use std::path::PathBuf;
use anyhow::{Result, anyhow};
use axum::extract::Multipart;
use uuid::Uuid;
use tokio::fs;
use image::{ImageReader};
use webp::Encoder;
use base64::{Engine as _};

use super::{ImageService, Image, Visibility};
use crate::event::{CommunityEventSender, Event};
use crate::request_context::RequestContext;
use crate::service_registry::ServiceRegistry;
use crate::app_config::Config;

const ONE_MB: usize = 1_000_000;

pub fn is_supported_image(ct: &str) -> bool {
    matches!(
        ct,
        "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/heic" | "image/heif"
    )
}

#[derive(Clone)]
pub struct ImageView {
    _config: Config,
    _community_slug: String,
    image_service: ImageService,
    _registry: Arc<dyn ServiceRegistry>,
    event_sender: CommunityEventSender,
    community_path: PathBuf,
}

impl ImageView {
    pub fn new(
        config: Config,
        community_slug: String,
        image_service: ImageService,
        registry: Arc<dyn ServiceRegistry>,
        event_sender: CommunityEventSender,
        community_path: PathBuf,
    ) -> Self {
        Self {
            _config: config,
            image_service,
            _registry: registry,
            event_sender,
            community_path,
            _community_slug: community_slug,
        }
    }

    pub async fn save_image(&self, multipart: &mut Multipart, user_id: &Uuid, ctx: &RequestContext) -> Result<Image> {

        let data_directory = self.community_path.join("images");

        fs::create_dir_all(&data_directory).await?;

        let file_id = Uuid::new_v4();
        let mut saved_image_path: Option<PathBuf> = None;
        let mut visibility = Visibility::Private;

        // Process multipart fields one at a time: the only field we care about is "image"
        while let Some(field) = multipart.next_field().await? {
            match field.name().unwrap_or("") {
                "image" => {
                    // Basic type check
                    let content_type = field
                        .content_type()
                        .unwrap_or("")
                        .to_ascii_lowercase();

                    if !is_supported_image(&content_type) {
                        return Err(anyhow!("unsupported image type: {}", content_type).into());
                    }

                    // Decide final destination
                    let filename = format!("{}.webp", file_id);
                    let path = data_directory.join(&filename);

                    // TODO: this is definitely blocking: we should do this in a separate thread
                    let webp_data: Vec<u8> = {
                        // Stream to memory first
                        let data = field.bytes().await?;
                        if data.len() > ONE_MB {
                            return Err(anyhow!("image too large (max 1MB)").into());
                        }
                        // Convert into an image object
                        let img = ImageReader::new(std::io::Cursor::new(&data))
                            .with_guessed_format()
                            .map_err(|e| anyhow!("failed to read image data: {}", e))?
                            .decode()
                            .map_err(|e| anyhow!("failed to decode image data: {}", e))?;

                        let enc = Encoder::from_image(&img)
                            .map_err(|e| anyhow!("failed to encode image to webp: {}", e))?;
                        let webp_data = enc.encode(90.0f32);
                        let webp_u8: Vec<u8> = webp_data.to_vec();
                        webp_u8
                    };

                    fs::write(&path, &*webp_data).await?;

                    saved_image_path = Some(path);
                }
                "visibility" => {
                    let value = field.text().await?.to_ascii_lowercase();
                    visibility = match value.as_str() {
                        "globalpublic" => Visibility::GlobalPublic,
                        "public" => Visibility::Public,
                        "private" => Visibility::Private,
                        _ => {
                            return Err(anyhow!("invalid visibility value: {}", value).into());
                        }
                    };
                }
                _ => { /* ignore other fields */ }
            }
        }

        match saved_image_path {
            Some(path) => {
                let image = self.image_service.create_image(
                    &file_id,
                    path.to_str().unwrap_or(""),
                    "webp",
                    user_id,
                    visibility,
                ).await?;

                tracing::warn!("Created image: {:?}", image.id);

                // Emit event
                self.event_sender.send(
                    Event::UserImageUploaded {
                        image_id: image.id,
                    },
                    Some(user_id.clone()),
                    Some(ctx.clone()),
                ).await?;

                Ok(image)
            },
            None => Err(anyhow!("no image field in multipart data").into()),
        }
    }

    /// Save a base64-encoded image string (with data URL prefix) as an image.
    /// e.g. "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
    /// The visibility parameter is optional; if not provided, defaults to "private".
    /// The user_id is the ID of the user uploading the image.
    pub async fn save_image_base64(&self, image_string: &str, visibility: Option<&str>, user_id: &Uuid, ctx: &RequestContext) -> Result<Image> {

        let data_directory = self.community_path.join("images");

        fs::create_dir_all(&data_directory).await?;

        let file_id = Uuid::new_v4();
        let visibility = match visibility {
            Some(v) => match v.to_ascii_lowercase().as_str() {
                "globalpublic" => Visibility::GlobalPublic,
                "public" => Visibility::Public,
                "private" => Visibility::Private,
                _ => {
                    return Err(anyhow!("invalid visibility value: {}", v).into());
                }
            },
            None => Visibility::Private,
        };

        let image_data = if let Some(comma_index) = image_string.find(',') {
            &image_string[comma_index + 1..]
        } else {
            return Err(anyhow!("invalid image data").into());
        };
        let image_buf = base64::prelude::BASE64_STANDARD.decode(image_data)
            .map_err(|e| anyhow!("failed to decode base64 image data: {}", e))?;
        if image_buf.len() > ONE_MB {
            return Err(anyhow!("image too large (max 1MB)").into());
        }

        // Decide final destination
        let filename = format!("{}.webp", file_id);
        let path = data_directory.join(&filename);

        // TODO: this is definitely blocking: we should do this in a separate thread
        let webp_data: Vec<u8> = {
            // Convert into an image object
            let img = ImageReader::new(std::io::Cursor::new(&image_buf))
                .with_guessed_format()
                .map_err(|e| anyhow!("failed to read image data: {}", e))?
                .decode()
                .map_err(|e| anyhow!("failed to decode image data: {}", e))?;

            let enc = Encoder::from_image(&img)
                .map_err(|e| anyhow!("failed to encode image to webp: {}", e))?;
            let webp_data = enc.encode(90.0f32);
            let webp_u8: Vec<u8> = webp_data.to_vec();
            webp_u8
        };

        fs::write(&path, &*webp_data).await?;

        let image = self.image_service.create_image(
            &file_id,
            path.to_str().unwrap_or(""),
            "webp",
            user_id,
            visibility,
        ).await?;

        // Emit event
        self.event_sender.send(
            Event::UserImageUploaded {
                image_id: image.id,
            },
            Some(user_id.clone()),
            Some(ctx.clone()),
        ).await?;

        Ok(image)

    }

    ///
    /// Get an image by ID, checking permissions based on the requesting user and admin status.
    ///
    /// If the image is found and the user is authorized to view it, returns Some(Image).
    /// If the image is not found or the permissions aren't kosher, returns None.
    pub async fn get_image(&self, id: &Uuid, requesting_user: &Uuid, is_admin: bool, _ctx: RequestContext) -> Result<Option<Image>> {
        if let Some(image) = self.image_service.get_image(id).await? {
            // Check visibility
            match image.visibility {
                Visibility::GlobalPublic => Ok(Some(image)),
                // technically, if we HAVE a requesting_user, we must be logged in, so we can assume that if we're here, we're authenticated
                //  and any Public image is viewable. GlobalPublic requires a different, unauthenticated path.
                Visibility::Public => Ok(Some(image)),
                Visibility::Private => {
                    if &image.user_id == &requesting_user.to_string() || is_admin {
                        Ok(Some(image))
                    } else {
                        Ok(None) // Not authorized
                    }
                }
                Visibility::Hidden => {
                    if is_admin {
                        Ok(Some(image))
                    } else {
                        Ok(None) // Not authorized
                    }
                }
            }
        } else {
            Ok(None) // Not found
        }
    }

    /// Get a public image by ID, without any user context.
    /// Only images with GlobalPublic visibility are accessible this way.
    pub async fn get_public_image(&self, id: &Uuid) -> Result<Option<Image>> {
        if let Some(image) = self.image_service.get_image(id).await? {
            // Check visibility
            match image.visibility {
                Visibility::GlobalPublic => Ok(Some(image)),
                _ => {
                    Ok(None) // Not authorized
                }
            }
        } else {
            Ok(None) // Not found
        }
    }

}