#!/bin/bash

echo "Starting all services with Docker Compose..."
docker-compose up -d --build

echo "Checking if Llama2 is already installed in Ollama..."
llama2_exists=$(ollama list | grep -c '^llama2')
if [ "$llama2_exists" -eq 0 ]; then
	echo "Llama2 not found !"
	read -p $'\nDo you want to install the `Llama2` model in Ollama for indexing? (y/n): ' install_llama2
		if [[ "$install_llama2" =~ ^[Yy]$ ]]; then
			ollama pull llama2
		else
			echo "Skipping Llama2 installation."
		fi
else
	echo "Llama2 is already installed in Ollama."
fi
