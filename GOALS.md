# Human written goal. Why this whole project exists.

I am a human that worked at a company moving towards AI. The company pushed AI adoption along a predictable path where gradually almost all of the code was written by AI, and PR review became the bottleneck. Many attempts at automating PR review were attempted. Most of them added value. None of them removed the bottleneck.

The team I was on was in the "Generate everything and Review even harder" mode that I suspect many companies today are pushing into. It was not uncommon for me to wake up in the morning and spend the first 4 hours of my day doing code reviews for my teammates while babysitting claude as my own code was generating. The back half of my day was often spent reviewing my own generated code, verifying it, taking screenshots, recording logs, ect... Anything that I could attach to a pull request to make it easier on my team to review my work.

The whole thing was very exhausting. I was burning out very hard. Cisco had some data on this showing that reviewers tend to start letting bugs through when they're asked to review over 400 lines of code in one sitting, and it gets really bad at over 450 lines of code per hour. Exact numbers and metrics have wildly varing definitions (450 lines of crud is nothing, 450 lines of cryptography will melt your brain), so large grain of salt on that one, but my lived experience proved that you can only review so much code before your brain feels like mush and you want to go lay face down on the floor somewhere quiet. There's also the aspect of "one function with 450 changes" being cognitavely easy. "450 functions with 1 small change each" will melt your face clean off.

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

Today I see I have a new recorder module in this project. It's telling me that we've added C++ support. I click into it and am shown a diff with a big glowing new top level module representing the new C++ module. There's a glowing line to core representing new abstractions in there that were needed to support something unique about C++. Off to the side i see a list of new use cases that I can go through.

On a default view everything inside about how the specific language generates the universal trace is hidden. There should be two dependency lines that point to a core module and an infra module. Core should contain an in memory representation of the universal trace as well as the test config. Infra should determine how those files are actually saved and loaded from disc. Today only the core module glows with a change.

Click into the new recorder module and I'll probably see lots of nested file handling code and core parser classes, a bunch of classes and bare functions linked to parsing the language specific traces into the universal format. I'd expect to see each module being put together differently but each module having lots of sub modules, maybe one for checking if everything is installed correctly, one for running the tests, one for parsing the results into a universal format and probably other sub modules that I haven't thought of yet. Maybe at this layer I'd even start seeing some class definitions or functions. Since I'd expect that the universal format isn't c++ specific I'd also expect that the core module would handle that file parsing in it's own data layer but all of that would be behind an interface.

Click into it even deeper and I'd probably start seeing the classes and bare functions of the project. If I'm reviewing some changes maybe some would be highlighted so I could see that something. Lets imagine I click on a class, then in that class see a highlighted function and I'll click on that function to see a diff of what changed there.

In the diff I'll have a view of the unit, and integration, and end to end tests that were effected by the code that I'm looking at listed out. I kinda imagine them as light beams that I could reach out and click on and then explore the execution trace of a specific test backwards and see how the timings change. From here I might want to go through a lot of different real user use cases first, and then dig into the edge cases from the unit tests next to see how those are handled. I might be able to check off a portion of the code review and approve some parts, so that I can make sure i'm not missing anything.

If I see anything i'd like to be able to make comments on it. Maybe there's a port where those comments resolve out to a comment on the pull request in github, or maybe I just want to assemble a list of minor tweaks to direct an ai agent to look at and evaluate. Maybe some of them generate new work tickets, or some of them could just be fixed while I'm still reviewing.

Once done I can elect to approve the PR if it looks good, send my comments to a local agent to clean up, or just post the comments on github for someone on the team to review (if it's not my work).