# Human written goal. Why this whole project exists.

I am a human that worked at a company moving towards AI. The company pushed AI adoption along a predictable path where gradually almost all of the code was written by AI, and PR review became the bottleneck. Many attempts at automating PR review were attempted. Most of them added value. None of them removed the bottleneck.

The team I was on was in the "Generate everything and Review even harder" mode that I suspect many companies today are pushing into. It was not uncommon for me to wake up in the morning and spend the first 4 hours of my day doing code reviews for my teammates while babysitting claude as my own code was generating. The back half of my day was often spent reviewing my own generated code, verifying it, taking screenshots, recording logs, ect... Anything that I could attach to a pull request to make it easier on my team to review my work.

The whole thing was very exhausting. I was burning out very hard. Cisco had some data on this showing that reviewers tend to start letting bugs through when they're asked to review over 400 lines of code in one sitting, and it gets really bad at over 450 lines of code per hour. Exact numbers and metrics have wildly varing definitions (450 lines of crud is nothing, 450 lines of cryptography will melt your brain, 450 in one file/class is fine, 450 modifications across 100 classes is absurdly too much), so large grain of salt on that one, but my lived experience proved that you can only review so much code before your brain feels like mush and you want to go lay face down on the floor somewhere quiet. There's also the aspect of "one function with 450 changes" being cognitavely easy. "450 functions with 1 small change each" will melt your face clean off.

## Plan and attack
So I started to attack the exhaustion like any other engineering problem. Break it down and figure out what I could automate. Automatic code reviewers like coderabbit and github copilot were already a part of the equation and did a good job, but what was my brain actually doing when I reviewed code?  And perhaps more importantly, what was I doing specifically when I was most tempted to LGTM and press the approve button, an act that would let bugs get past me. 

I'm a visual thinker. Whenever I'm reading code i'm building up a mental model of what that code is doing and organizing it into shapes that I can visualize in my head. When I hit a block of code that changed I often had to look at who was using the code. Who's calling this? Where's the channels back to customer impact. How long does this take to run? Does that matter? For a rest request from a customer UI it matters, from a background task that runs at midnight it matters a lot less. 

What was eating the most mental energy was seeing a ticket and a block of code and then working backwards to mentally model how it fit into the system, then once I found the entry points imagining which of my users would be using those systems, then rapidly switching through all the user contexts imagining what they were doing and how this would effect them. The pressure to not forget any business context and miss a use cases that wrecks a users day was a very real pressure. That's the pressure that became acute to me when the company policy was "Just Review Harder".


## I can break those problems down:

#### Use case identification
There's the ability to identify my users and know the business context around what they're doing. These are kinda easy if your company has a set of good end to end tests and just about impossible if that's the kind of thing that gets deprioritized in the rush for new features. Problem: End to End tests often say Pass or Fail. Sometimes they even come with a "How long" but I don't have any tooling to diff that if user login suddenly takes an extra 15 seconds.

#### Building a mental Map
There's the "building the mental map" aspect. Reading code that changed, then working backwards to figure out who calls it in a way that I can use to build up a architecture diagram in my head of how this specific chunk of code is working. 
This is hard and subjective. Systems might be like layered, cqrs, event driven, service oriented, component, hexagonal, and probably a dozen more that I can't think of off the top of my head. And those all make sense depending on the scenario. The only wrong opinion in my opinion is to try to do all of them at the same time. Loooots of AI slop that I found came from either crossing the streams and mixing the styles all in one place, or (less frequently) dogmatically trying to apply the wrong arch in places where it didn't belong. 
The dogmatic application thing was a big deal to me. There are seams in a code base where a use case can jump through a layered architecture for one part, then jump into a hexagonal for another, then fire off a event driven task in response and a lot of mental energy was spent staring at a flat wall of text and trying to visualize a system one way, failing and then realizing that I had to switch modes to think about it a different way. 

#### Performance impacts
I spend a lot of time thinking about deep nested loops, what weird sql is this orm going to generate for this query, or looking up to be sure what indexes are set on the table and if adding an index is going to tank insert performance and if that's worth the query performance along literally hundreds of other little trivia factors that have been burned into my brain over the last 20+ years of writing code. It'd sure be nice if something just kinda called out, "Hey this block of code is now going to take an extra n milliseconds. Here's when and who is going to be waiting. Are you cool with that?" It takes a lot of mental energy to work back every path from a code block that adds a network call to make sure nothing calling that function is in a tight loop. Being able to see the performance impacts with an upfront diff would be fantastic to just be able to read and not have to imagine.

#### The Ticketing Story
I'd like to know what we're even doing here. Digging through Jira and Confluence and a bunch of meeting notes to figure out what product actually wants also requires a lot of mental energy. I've got to clearly see the problems that the users have in my head, and then scope those problems down to a chunk of functionality. What are we improving here? What are we preventing? In what context. I feel like this is a classic LLM RAG usecase to just go out and figure it out and present it to me so I don't have to go digging.

#### If I can see it's a problem immediately so can AI
This whole thing was written with the goal that hard to understand systems are hard for me to review but they also probably suck for an AI agent who's given a task and just wants to get it done. I want to be able to put something in front of an agent and have it work, then have it do all it's checks to try to reduce slop, then have it run all the above checks. Did you do something to the user that breaks an important use case? Did you script kiddie a hack in to make something work that every other ai agent after you is going to have to work around? Did you even know that the change you made was going to tank performace of some user that was out of your context window?
Why not have an AI be able to see what a human reviewer is going to see before the humans weak fleshy brain has to see it and think about how to fix it? An AI agent should be suspicious of AI generated code by default, this just gives it more hard evidence to determine if something's going to be a false positive or not. Which is always good.

## Goals

I want to feel like Tony Stark figuring out time travel. I love all those cool movie visualizations describing how a system works, and in my head I'm putting together those visualizations and imagining how data flows through them for different end to end use cases. Weird goal right? But that's the goal. Imagination is delightful when you get to do it. It's exhausting when you get someone telling you to just imagine harder and faster and even harder and even faster. I want to wake up in the morning and see my 8-10 a pull requests going from various feature branches to main. I want to be able to dig into one and see a summary of what's going on and why it's changing. Maybe some call outs about things it found along the way. I'd like to be able to look at visualizations of code without actually having to read walls of text but then be able to dive in and actually read the wall of text where it'd contextually important. Where it's costing performance. Where it's adding systematic or cyclomatic complexity.
I want to have a list of threads to follow and work through them. If I'm reviewing a change to a system I want a list of who's end to end workflows travel through it.
I want to visually know how to think about a system. If it's a hexagonal architecture in one area of the code base, just show me a hexagon shape. If it's a layered, then show me something that visualizes that. Event driven then a different symbol. Make it easy for me to see the seams where one shape starts and another ends, and then once my imagination knows what to start with I'll be able to dive in know the context of "How should I visualize this particular section of the giant wall of text PR that was submitted".

I'm probably going to want something that I can see in VS Code or in a Meta Quest 3s headset. I want something that's also 2D compatable, and something built for agentic consumption. I'm going to want something that can review python, javascript/typescript, go, C# and C++, but doesn't have to have all of that weight installed.

Something that probably runs on a schedule so I can kick it off, let it chew on the problem, let it see the changes and let it make it's own corrections if what it sees looks off.

## Secondary goals

I want to use runshape to build runshape. So here's where I'm going to envision what I think this should look like in my own head today.

#### Recorder Modules:
There's 3 modules for the go, typescript, and python code recorders. As I add languages, more modules will pop up. Each module is a box with a line going into it that accepts a free form object describing the location of some code and how to run it and collect trace information. There is one line going out and it's the line where we pass along a universal trace object. 
These three modules are language native and run unit/integration/end to end tests and record trace data. 

Input test config -> output universal trace.


#### Architecture Categorizer Module
There is an llm based module that has a bunch of skills that make judgement calls about uncategorized classes and determines where in the architecture it belongs (and can tag if a class or function is breaking some architectural rules that would put it in multiple categories). Input code files and previous architecture decisions, output architectural information. Any classes/functions in the diff can get marked and identified in a semantic way so I can know if a functiton just got renamed. If a function belonged in one zone and has now started to do something that belongs to another zone that gets called out.

There's an enhancement step in the module that enhances the universal trace abstraction with architecture information and calls out new uncategorized classes. Something to bridge the gap Any new or changed classes prompt the llm module to review it and give it a place. Input universal trace -> output architecture enhanced trace.

#### Explainer Module
A second llm based module that focuses on evaluating and explaining code changes. It might read comments, docs, jira tickets, or other ticket information to build context around why code has changed. This should probably 

#### Arch Trace Diff Module
A diff module that can take two architecture enhanced traces and mechanically create a diff of them. May call out to the expiainer or cagegorizer module to help enhance the trace diff with contextual meaning.

#### Visualizers
Some sort of pre-visualization rendering module, since I imagine that this will be a lot of data and what we should be sending out to 3js or the user interface will need to be optimized since the UI already lags pretty hard when loading up complex diagrams. I imagine there will be a step where we break up the regions and nested zones into a smaller more optimized shape. This shape has implications for the rendering performance, but also should help an AI agent cut through the noise to know what the human is really going to be looking at so it can get ahead of things.

##### Flat Rendering
10: 2d rendering module: A quick way to render these diffs in 2d for flat screen viewing. I should be able to re-arrange a module in a way that makes sense and have that arrangement mostly stick around between diffs. It's a format that lets me arrange the new architecture diagram as I go.

##### 3D Rendering 
A very visual way of rendering these diffs in 3d that also allows me to arrange things since 2D renderings can often get very cluttered up. Also fills the dream of me being able to put on a vr headset and use my hands to organize the software architecture.

#### A review module
This is where I get a user experience that allows me to view performance numbers, review execution paths, maybe use a keyboard or something like whisper to leave comments on a pull request and request changes or approve.


## How I imagine reviewing a PR on a Recorder Module. 

An example for what I really want this to turn out to be like. This is an imaginary scenario, but something to keep in mind of what I'm ultimately looking for.

In the morning I wake up and am greeted with a list of things to review. I get a good single line description. Maybe there's some new stacked PR with 8 things to review. I can start with the first one and start rolling in.

Today I see I have a new recorder module in this project. It's telling me that we've added C++ support. I click into it and am shown a diff with a big glowing new top level module representing the new C++ module. There's a glowing line to the kernel representing new abstractions in there that were needed to support something unique about C++. Off to the side i see a list of new use cases that I can go through.

On a default view everything inside about how the specific language generates the universal trace is hidden. There should be two dependency lines that point to the kernel and from an injected infra module. The kernel should contain an in memory representation of the universal trace as well as the test config. Infra should determine how those files are actually saved and loaded from disc. Today only the kernel glows with a change.

Click into the new recorder module and I'll probably see lots of nested file handling code and core parser classes, a bunch of classes and bare functions linked to parsing the language specific traces into the universal format. I'd expect to see each module being put together differently but each module having lots of sub modules, maybe one for checking if everything is installed correctly, one for running the tests, one for parsing the results into a universal format and probably other sub modules that I haven't thought of yet. Maybe at this layer I'd even start seeing some class definitions or functions. Since I'd expect that the universal format isn't c++ specific I'd also expect that the kernel would handle that file parsing in it's own data layer but all of that would be behind an interface.

Click into it even deeper and I'd probably start seeing the classes and bare functions of the project. If I'm reviewing some changes maybe some would be highlighted so I could see that something. Lets imagine I click on a class, then in that class see a highlighted function and I'll click on that function to see a diff of what changed there.

In the diff I'll have a view of the unit, and integration, and end to end tests that were effected by the code that I'm looking at listed out. I kinda imagine them as light beams that I could reach out and click on and then explore the execution trace of a specific test backwards and see how the timings change. From here I might want to go through a lot of different real user use cases first, and then dig into the edge cases from the unit tests next to see how those are handled. I might be able to check off a portion of the code review and approve some parts, so that I can make sure i'm not missing anything.

If I see anything i'd like to be able to make comments on it. Maybe there's a port where those comments resolve out to a comment on the pull request in github, or maybe I just want to assemble a list of minor tweaks to direct an ai agent to look at and evaluate. Maybe some of them generate new work tickets, or some of them could just be fixed while I'm still reviewing.

Once done I can elect to approve the PR if it looks good, send my comments to a local agent to clean up, or just post the comments on github for someone on the team to review (if it's not my work).

## Target architecture (draft)

How the modules above should fit together so I can keep adding new ones (explainer, arch diff, visualizers, things I haven't thought of yet) without them tangling into each other. This describes where we're going, not what the code looks like today.

The shape is a shared kernel inside a modular monolith. Every module points at the kernel. The kernel doesn't know who's using it. Modules never import each other. The apps are the only things that know about more than one module.

```
                 ┌──────────── apps: extension · cli · gha ────────────┐
                 │  load/save via infra, call modules in order, wire   │
                 └──┬─────────┬──────────┬───────────┬─────────┬───────┘
                    │         │          │           │         │
                 trace      arch     explainer   visualizer   infra
                    │         │          │           │         │
                    └─────────┴────┬─────┴───────────┴─────────┘
                                   ▼
                                 kernel
               (shared types, shared formats, generic ports)
```

#### Kernel
The glossary of the project. If two modules exchange something, its type and its file format live here: `Trace`, `TraceDiff`, `ArchTrace`, `Review`, `Comment`. The kernel also defines the generic ports modules may need injected: `LanguageModel` (text in, text out), `Logger`, maybe `Clock`. The kernel does no real IO and imports no other Runshape package.

A type only moves into the kernel when a second module needs it. Until then it stays in the module that owns it. Changing the kernel means somebody else is affected, so the kernel should stay small and change rarely.

The recorders (Go, Python, TypeScript) are separate processes in their own languages. The kernel's trace format is the contract they write to.

#### Modules: values in, values out
Each module is a small bundle of its own that depends only on the kernel. Modules take values and return values. The app does the loading and saving.

- trace: `diff(Trace, Trace) → TraceDiff`
- arch: `enhance(ArchTrace | null, Trace, LanguageModel) → ArchTrace`, `explainDiff(ArchTrace, ArchTrace, LanguageModel) → ExplainedArchDiff`
- explainer: `explain(CodeDiff, TraceDiff, Context, LanguageModel) → ExplainedCodeDiff + Review`
- visualizer: `layout(ArchTrace, PreviousLayout | null, LanguageModel) → Layout`

Modules don't call each other. The explainer doesn't call trace's `diff`; it receives a `TraceDiff`. That's what keeps them self-contained, and it's what lets me add a module without touching the others.

A module's LLM skill (its prompts and how it parses the answer) belongs to that module. The kernel only knows there's a `LanguageModel`. The kernel never knows what an "architecture prompt" is.

A file format only one module reads belongs to that module, with its own serializer. The visualizer's human-arranged layout file is the first example.

#### Infra: adapters at the edge
Infra implements the kernel's ports and does the actual IO: disk, git, `claude -p`, the Anthropic API, GitHub comments. It's split by the external system it talks to. A system only gets its own package when it brings in a dependency the other apps shouldn't have to carry. Infra is never imported by the kernel or by a module. It reaches them only by being injected from an app.

I want this to run as a few different apps so maybe having an infra-cli and infra-vscode modules in the format of infra-[appname]. But that's not exactly a clean break and I could end up implementing stuff like posting github comments twice, so maybe having an infra-shared would also make sense? Maybe just infra-shared and let the app specific infra exist inside the app module itself like vscode.infra.

#### Apps: the composition roots
The extension, CLI and GitHub Action start everything. Each one picks its adapters (VS Code's file and model APIs inside the extension; disk and `claude -p` from the CLI; an API key and PR comments in GHA), loads what's needed, calls modules in order, and saves the results. Adapters that can only run inside one host (anything importing `vscode`) live in that host's package. The UI (2D and 3D renderers) is its own package and talks to the app over a protocol.

When a workflow like "load the last two ArchTraces, diff them, explain them, save" is needed by a second app, it moves into a `workflows` package. That package may import modules and the kernel, never infra or a host.

#### Rules a tool checks
- The kernel imports nothing from Runshape.
- A module imports only the kernel.
- infra imports only the kernel.
- Only apps (and `workflows`, for modules) import more than one of these.

These get enforced by a lint rule in CI (dependency-cruiser or eslint-plugin-boundaries), not by me remembering them.




# High level breakdown of Arch use cases.

I should be able to scan a code base and gather architectural information according to the following categories:
   Container - Modules, namespaces, packages, directories, files. Containers can be nested and create groups.
   Types - classes, structs, interfaces, traits, enums.
   Callables - free function, function, method, constructor, closure.
   State - fields, properties, constants, globals, statics.
   Metadata - attributes, annotations, decorators.

I should be able to visualize the architectural information.

Each item of architectural information should be enhanced with metadata that determines it's exact type.
   Containers - Modules, namespaces, packages, directories, files, other? Maybe meta containers that can span other containers like something that would allow me to see all the Controllers in a project?
   Types - (Some type of Wirf-Brocks role stereotypes + DDD Building blocks + Hexagonal Port/Adapter) Is this a DTO, domain object,  Relationship/index/collections, Orchestrator, Controller, handler, value object, record, config, entity, aggregate root, adapter, port, policy/domain service, use case/application service, event and probably a lot more.
   Callables - (Functional Core Imperative shell, CQS) Pure vs Effectual, Query vs Command or a combination, Total validation or can fail/throw, Decision vs Orchestration.
   State - mutable, immutable, global/static, cached maybe?, 
   Metadata - Don't know what you'd enhance here. Ideas?

I want to be able to configure it per project based on what makes sense. There should be built in generic definitions, but I should be able to tweak what they mean. I want to be able to load up the definitions and see a blurb of text that a llm like haiku or sonnet could quickly use to tune how I evaluate each chunk of code and what metadata it gets tagged with.

I want to be able to create rules based on the metadata and have default rulesets based on named architecture best practices. 
   Example: If I say that things in this container are using CQRS then I want a rule that calls out when a function in that containger is mixing query+command.
   I also want to be able to not be so dogmatic about things and be able to relax the rules sometimes, or define my own rules for what makes sense in the code base.
   Maybe have others define out of the box architecture rulesets when this gets released open source.


# Demo

This records a theoretical demo I'd like to give of the product.

This is the intro to runshape and how you can use it.

Runshape started from a problem, I was burning out. There were too many systems to maintain, and they were changing so quickly that it became very mentally taxing to stay on top of them.

So I sat down and broke the problem down and came to the conclusion that what was causing my burnout was constantly having to read large walls of code in my head and then visualize what they were doing. 
Questions like, what is this, when does this code run, what users does this effect, how does it interact with the other systems around it, should this code be here. A lot of what i was doing when I was jumping into new systems was creating abstractions in my head of what the code did at run time, then I'd have to visualize the shape of the system and how logic flowed through it.

So like any good engineer I broke the problem down, attempted an implementation and that's what runshape has become.

### Phase 1: Evaluating a new code base

Lets see an example of a Go program. I like Go because it's very opininated and that makes it easy to understand what should go where. This go program has http handlers, grpc handlers, a scheduled task processor, integration test harnesses, and unit tests. Each has a different startup routine. When I first open runshape I can see these different ways that the code will run immediately and that alone is a big deal for the first time you open up a code base.

In this code base you can look at the unit tests as a shape with a lot of lines going into the core of the system, however there's a few unit tests that seem to go into the http handlers, maybe those are fine, but that could be sloppy. Maybe I'll look into why that is and that's kinda the point of the tool. In this project maybe I want to keep my handlers thin and well tested by the integration tests, so I can move over and check the itegration tests and I see a bunch of lines going from the integration test into the http handlers and grpc handlers, but I notice by it's absense that there are some handlers that don't have any lines going to them. That could be sloppy as well maybe it's something to look into.

If from the integration tests i click into the http handlers I can pick a test (use case) and explore how the http handlers look at run time. What objects/shapes are created when the program actually starts up? How does logic flow through middleware and into the handler, and then down into the core of the system? I can follow the traces, and I can see the relative timing of the traces. If I follow it long enough I can see it drop down into a database schema and examine what tables are effected and maybe what the actual shape of the data at rest is. I continue watching execution flow back up into the core region through the various services and then finally back to the http handler where it returns the data as output. I can examine the data that it returns and compare it with the data in the database.

At any point in the process I can click on one of the shapes and examine the code that's backing it. If i see some data in the response I can dig in and find out how that data was derived in a service. Finding out where though is traditionally difficult and can involve bouncing through a bunch of stacks looking for a needle. Thankfully runshape also tags your code with what it's is. If what I suspect what I'm looking for is business logic then I can view functions in this trace that are doing business logic, if it's serialization logic I can check the serializers, if it's a validation error then I can quickly jump to just the code in the trace that handles validation.

### Phase 2: Diffs and day to day

This is all just phase 1 where we're using runshape to learn about a static system (which is valuable all on it's own!). The truly interesting part of runshape is when that data changes I can get a diff of all of this data. Lets take for example this simple diff where we added a phone number to our user registration. I can take a look at it and see that it looks like we've altered the http handler to add a new phone number field and we've added some validation to make it a required field on user setup and some logic to be sure it's a valid phone number. In addition we've updated the user profile object in core to add a phone number as well as a database migration that adds the phone number in a field to the database. There's also a user registration end to end test that was modified. I can click on the test and read the code diff to see that a phone number was added, and I can then trace how that phone number jumps into the handler, gets validated, added to the user profile, and is saved to the table in the database. But when I look at the user profile repository I see there are a few other callers into this function that aren't the user registration. I can see that create is called from an rpc endpoint as well as from a background task. Curious I check the RPC endpoint and notice that it doesn't have the phone number. I decide to leave a comment and specify that we're missing the phone number in the RPC endpoint and that should be added to this PR as well. Continuing the review I check what's going on from the background worker. We have a file upload that bulk creates new users and that file doesn't include phone numbers. This is problematic because phone number is set as a required field in the database so all bulk uploads will break if we merge this PR. I leave a comment directing attention to the bulk uploads and suggest that phone number should be a nullable field or to also update the bulk upload to send a blank phone number. Also I notice that the phone number validation is being done in the http handler and i'd like to move that down into the service layer so that it gets reused from the grpc and background workers. Once i'm done with the review I could opt to post all of my commentary back as comments on the github pull request, but I decide to be nice and direct my comments to a claude and ask it to make up a new branch that fixes up these issues and issue a pull request to this branch for me to review. That's one of my eight pull requests down, and I move on to the next one.

### Phase 3: Customizing the architecture with Philosophy

Reworite this. I should talk about a repo where you can setup default architectures for language-framework. Runshape should be able to consult an open source repo where you can get the basics for how things are normally setup. 
Once you have normal, you can then customize it by company with local copies or by forking the repo and altering it locally, and then make micro adjustments with comments in the readme.md files. 
--- 
Humans are in charge of defining what makes sense to them. A lot of times what we call AI slop is really just code that's difficult to understand or code we just don't understand yet, however before we had agentic coding it was pretty common to look at someone elses code (or our own code from last year) and get very critical about how sloppy it was as well. Last years overly clever is this years human slop.

The fewer 'clever' things going on in the code base the faster we're going to be able to understand it. But that doesn't mean that clever isn't always warranted. Sometimes you really do need to do complicated things, but those should be documented. 

Second point is Django. I do a lot of Django and it's useful because it's a batteries included framework. The problem is that is has 20 years of tens of thousands of developers making different batteries with different ideas and philosophies. FastAPI is a little better, but it's still wild how many different ways there are to think about code and each one has it's merits. I like to say that there are two wrong answers for acrhitecture: picking all the answers or picking none. The more conflicting philosophies you have about your code base the harder it is for any one philosophy to take hold and simplify things for you. When you have an ai agent trained on every different philosophy on the internet you can get wildly different results depending on what it's doing and where it's workign in a code base. Different sections of a code base might look wildly different, example a django app where most things just use the normal out of the box stuff to do crud work and then there's this one model that gets it's rest endpoints half from the database and half from a network call. Suddenly you have a wildly different shape and that's ok. It should be immediately obvious and documented.

That's why i decided that I wanted !-- runshape -- comments in local readme files that help explain what patterns should be used in a section of the code base and in the event that I don't understand what's going on, there's some comments left to help me get up to speed quickly. When runshape runs it evaluates what is normal, what is new, how the diff changes and if something is looking sloppish maybe it's there for a very good (and documented) reason but maybe the complexity isn't worth it and it should be refactored into a shape that's easier to understand. Write code that's meant to be readable taken to the next level.

It also has customizable rules that an llm can use to determine the shape of the code, how to tag classes, and how it should all work together.

Eventually I think I want the runshape rules to be contributed to their own repo where they can be publically maintained independantly of the runshape application code. I imagine that there could be a default django, fastapi, maybe a django-ninja starter. Something with base rules and maybe you'd eventually fork it to create a django-acme-co that specifies that at the Acme company this is the rules for how we do Django.

### Phase 4: Having the AI consume this information

The nature of AI slop is really just having the ai write things that the humans can't understand easily.  Our goal isn't to be inserted into this for the sake of it. Our goal is to understand. The better agentic coding can produce code that we can quickly understand without getting mentally fatigued the better we will all be. If we can give the AI some signals about what's going to be hard to visualize or conceptualize then the AI will naturally write code we consider to be 'slop free'.

That's why running runshape produces ai consumable outputs. If we're adding a new abstraction that's company specific then we know 'how we do django around these parts'.