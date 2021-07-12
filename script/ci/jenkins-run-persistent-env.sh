#!/usr/bin/env bash
export INSIDE_WORKSPACE=/var/jenkins_home/dev-persistent/$JOB_NAME

mkdir -p $INSIDE_WORKSPACE/src
mkdir -p $INSIDE_WORKSPACE/data

cd $INSIDE_WORKSPACE/src;

docker-compose up -d --build