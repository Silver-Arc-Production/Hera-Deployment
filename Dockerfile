# syntax=docker/dockerfile:1

# Pin the interpreter: the test suite is validated against this minor version.
FROM python:3.13-slim

# PYTHONUNBUFFERED keeps logs streaming a line at a time, which is what
# Northflank's log view expects; without it output sits in a buffer for minutes.
# MPLBACKEND is belt-and-braces alongside the Agg backend set in hera/ui/charts.py.
# The cache directories are redirected to /tmp because the runtime user has no
# home directory and matplotlib would otherwise warn on every chart.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib \
    XDG_CACHE_HOME=/tmp \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first: editing application code then doesn't invalidate this
# layer. matplotlib ships manylinux wheels, so no compiler is needed.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# The runtime user is created before the application is copied so the sources
# can be owned by it in one step. Northflank grants ownership of an attached
# volume to the group configured in the image (see "Add a persistent volume"),
# so this gid is what the volume gets chowned to.
RUN groupadd --gid 10001 hera \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin hera

COPY --chown=hera:hera hera/ ./hera/

# chmod is explicit because COPY preserves the source file modes: a contributor
# building from a checkout with a restrictive umask would otherwise produce an
# image whose own source files the runtime user cannot read.
RUN chmod -R a+rX /app/hera \
 && mkdir -p /data \
 && chown -R hera:hera /data

# The SQLite file holding every balance and position. Northflank must mount a
# persistent volume at /data, otherwise each redeploy resets the whole economy.
VOLUME ["/data"]
ENV DATABASE_PATH=/data/hera.db

USER 10001:10001

# Docker sends SIGTERM on stop/restart, and hera/__main__.py turns that into a
# graceful shutdown: the ticker is cancelled and the database is closed before
# the process exits. SQLite's WAL mode makes even an abrupt kill safe, so no
# committed tick is lost either way.
CMD ["python", "-m", "hera"]
