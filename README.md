# Web-App Template
A webapp template that I use for everything - a python/flask backend with a node based HTML/CSS/JS front end

# General use instructions

## Getting Started

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes. See deployment for notes on how to deploy the project on a live system.

### Prerequisites

What things you need to install the software and how to install them.

```bash
npm
Python 3
docker
```

### Installing

A step by step series of examples that tell you how to get a development environment running.

- Clone the repository

```bash
git clone https://yourrepositorylink.com
cd your-project-name
```

- Install JavaScript dependencies

```bash
npm install
```

- Install Python dependencies

First, ensure you have a virtual environment created and activated:

```bash
pipenv shell
```

- Then install the dependencies:

```bash
pipenv install Flask
```
- Build the project

Before serving the project with Flask, you need to build the static files with Parcel:

```bash
npm run build
```
- This command compiles your assets into the dist directory.
Serving with Flask

To serve your project using Flask, run:

```bash
python app.py
```

Your project should now be accessible at ```http://localhost:5000```

### Development

For development, you can use Parcel's development server for hot reloading of changes:

```bash
npm start
```

And in another terminal, run your Flask application for backend functionality:

```bash
python app.py
```

Clearing the dist directory before builds

To ensure the dist directory is cleared before each build, the prebuild script in package.json is configured to run a clean operation:

```bash
"scripts": {
  "clean": "rimraf ./dist/*",
  "prebuild": "npm run clean",
  ...
}
```

### Contributing

Please be nice and polite while submiting PRs - use github to submit the PRs and open issues as requiered.

### License

This project is licensed under the MIT License - see the LICENSE.md file for details

### Acknowledgments

This was mostly done for a huge number of students and personal projects that I make with the Node - Flask - Mongo (Or whatever DB of your choice) Python allows for some really funky ML pipelines that would be impossible in other environments. 