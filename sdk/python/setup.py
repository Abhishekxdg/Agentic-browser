from setuptools import setup, find_packages

with open("../../README.md", encoding="utf-8") as f:
    long_description = f.read()

setup(
    name="agentbrowser",
    version="0.1.0",
    description="Semantic browser REST API client for AI agents",
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="Agent Browser",
    url="https://github.com/YOUR_USERNAME/agent-browser",
    project_urls={
        "Issues": "https://github.com/YOUR_USERNAME/agent-browser/issues",
    },
    packages=find_packages(),
    install_requires=[
        "requests>=2.28.0",
    ],
    python_requires=">=3.9",
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "Topic :: Software Development :: Libraries",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
    ],
)
