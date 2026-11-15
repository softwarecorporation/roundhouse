FROM rust:1.100-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home roundhouse \
    && mkdir -p /var/lib/roundhouse && chown roundhouse /var/lib/roundhouse
COPY --from=build /build/target/release/roundhouse /usr/local/bin/roundhouse
COPY LICENSE /usr/share/licenses/roundhouse/LICENSE
USER roundhouse
WORKDIR /var/lib/roundhouse
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/roundhouse"]
CMD ["/etc/roundhouse/config.json"]
