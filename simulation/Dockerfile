FROM node:18-slim

# Install dependencies for setup.sh and simulation scenarios
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        bash \
        git \
        curl \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# Set up a clean HOME directory (simulates a fresh machine)
RUN useradd -m -s /bin/bash simuser
USER simuser
ENV HOME=/home/simuser

# Copy the entire Wayfind repo into the container
COPY --chown=simuser:simuser . /meridian
WORKDIR /meridian

# Don't run anything at build time — scenarios run at test time
CMD ["bash", "simulation/simulate.sh"]
