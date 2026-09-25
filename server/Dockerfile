# syntax=docker/dockerfile:1
# A Ringtome server node (SERVER.md). The binary is the release's own, built for glibc 2.28 in the
# release workflow's `server` job and copied in here - this file compiles nothing, so the image for
# each architecture is that architecture's binary on a base with glibc and CA certificates, and a
# multi-arch build needs no emulation (there is no RUN step to emulate).
#
# Built by .github/workflows/release.yml's `image` job with the binaries laid out as
# bin/amd64/ringtome and bin/arm64/ringtome beside this file.
FROM gcr.io/distroless/cc-debian12:nonroot

ARG TARGETARCH
COPY --chmod=0755 bin/${TARGETARCH}/ringtome /usr/local/bin/ringtome
# The data directory, owned by the image's non-root user so a fresh named volume starts writable.
# It holds the node's KEYS beside its databases: the volume is the node's identity. Back it up.
COPY --chown=65532:65532 data/ /data/

# Said out loud rather than left to the binary's defaults, so `docker inspect` and this file tell
# the truth about what the container is (a release binary defaults to the same prod + mainline).
ENV RINGTOME_ENVIRONMENT=prod \
    RINGTOME_DISCOVERY=mainline \
    RINGTOME_BIND_ADDRESS=0.0.0.0 \
    RINGTOME_PORT=5281 \
    RINGTOME_P2P_PORT=5282 \
    RINGTOME_DATA_DIRECTORY=/data

# HTTP (put your own HTTPS proxy in front of it - SERVER.md) and the peer-to-peer port (UDP, QUIC):
# publish both. Without the UDP one the node still reaches peers through relays, only slower.
EXPOSE 5281/tcp 5282/udp
VOLUME ["/data"]
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/ringtome"]
