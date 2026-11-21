# slugify leaves a dash at the end

slugify("Hello, World!") returns "hello-world-". A slug never starts or ends with a dash, so it
should return "hello-world". slugify("--Rock & Roll--") should return "rock-roll".
