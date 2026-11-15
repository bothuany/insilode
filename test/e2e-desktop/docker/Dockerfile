# The Linux toolchain the desktop e2e run needs, and nothing of Insilode: the sources and the VS Code build live in a volume
# (scripts/docker-e2e.mjs), so this image is built once and a run after the first takes minutes.
# 22.04 and clang, as release.yml: the native modules do not compile with 22.04's GCC.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
		ca-certificates curl git xz-utils rsync build-essential pkg-config python3 \
		libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev clang-15 libstdc++-12-dev \
		xvfb xdotool libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libatk-bridge2.0-0 libdrm2 libxkbcommon0 fonts-liberation \
	&& rm -rf /var/lib/apt/lists/*

# Node 24 (VS Code 1.141 asks for 24.18 or newer; 25 will not do).
ARG NODE_VERSION=24.18.0
# The image is built for the machine's own architecture (arm64 on an Apple Silicon Mac under colima): an x64 Node there cannot even start.
RUN case "$(dpkg --print-architecture)" in arm64) NODE_ARCH=arm64 ;; *) NODE_ARCH=x64 ;; esac \
	&& curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" | tar -xJ -C /usr/local --strip-components=1

# The .NET 10 SDK: setup builds the C# analyzer with it.
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
	&& bash /tmp/dotnet-install.sh --channel 10.0 --install-dir /usr/share/dotnet \
	&& ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet && rm /tmp/dotnet-install.sh

ENV CC=clang-15 CXX=clang++-15 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 npm_config_update_notifier=false

# A checkout on Windows may have turned the script's line ends into CRLF.
COPY entrypoint.sh /usr/local/bin/insilode-e2e
RUN sed -i 's/\r$//' /usr/local/bin/insilode-e2e && chmod +x /usr/local/bin/insilode-e2e

WORKDIR /work/insilode
ENTRYPOINT ["/usr/local/bin/insilode-e2e"]
