"use strict";

/**
 * Indication pédagogique de repérage, et non garantie de visibilité.
 * Les magnitudes intégrées des objets diffus ne permettent pas, à elles seules,
 * de prédire leur contraste sur le fond du ciel.
 */
function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function normalizedId(object) {
  return String(object?.id || "").toUpperCase().replace(/\s+/g, "").replace(/\//g, "/");
}

export function assessObservingDifficulty(object, instrument = "all") {
  const altitude = finiteNumber(object?.alt);
  const magnitude = finiteNumber(object?.mag);
  const hasMagnitude = Number.isFinite(magnitude);
  const type = String(object?.type || (object?.catalogue === "Hipparcos" ? "star" : "deep-sky")).toLowerCase();
  const id = normalizedId(object);
  const equipment = ["eye", "binoculars", "telescope", "all"].includes(instrument) ? instrument : "all";

  if (type === "sun") {
    return {
      level: "challenging",
      label: "Protection solaire indispensable",
      explanation: "N’observe jamais le Soleil directement sans filtre solaire certifié et adapté, placé à l’avant de l’instrument."
    };
  }

  if (Number.isFinite(altitude) && altitude < 0) {
    return {
      level: "low",
      label: "Sous l’horizon — non observable maintenant",
      explanation: "La cible est actuellement sous l’horizon. Elle pourra être recherchée lorsqu’elle se lèvera."
    };
  }
  if (Number.isFinite(altitude) && altitude < 10) {
    return {
      level: "low",
      label: "Très bas sur l’horizon",
      explanation: "L’atmosphère absorbe et brouille davantage la lumière près de l’horizon. La cible peut être difficile à discerner ; attendre qu’elle monte aide souvent."
    };
  }
  if (Number.isFinite(altitude) && altitude < 15) {
    return {
      level: "low",
      label: "Bas sur l’horizon",
      explanation: "La proximité de l’horizon réduit souvent le contraste et la netteté. Même une cible brillante peut scintiller ou paraître affaiblie."
    };
  }

  if (type === "moon") {
    return {
      level: "easy",
      label: "Facile à repérer à l’œil nu",
      explanation: "La Lune se repère généralement sans instrument. La phase change l’éclairage du relief ; jumelles ou télescope révèlent davantage de détails."
    };
  }

  if (type === "planet") {
    if (hasMagnitude && magnitude <= 4.5) {
      return {
        level: "easy",
        label: "Généralement visible à l’œil nu",
        explanation: "On voit surtout un point lumineux ; les détails de la planète demandent un instrument. Les nuages, la transparence et une faible hauteur peuvent gêner l’observation."
      };
    }
    return {
      level: "medium",
      label: "Visibilité incertaine",
      explanation: "Cette planète est peut-être visible, mais cela dépend de son éclat et des conditions du ciel. Un instrument peut aider à examiner ses détails."
    };
  }

  if (type === "dwarf-planet") {
    if (!hasMagnitude) return { level: "variable", label: "Éclat estimé indisponible", explanation: "La magnitude apparente n’est pas disponible ; la visibilité de cette planète naine ne peut pas être estimée à partir du catalogue." };
    if (equipment === "eye") return magnitude <= 6.0
      ? { level: "challenging", label: "À la limite de l’œil nu sous un ciel sombre", explanation: "Même la plus brillante des planètes naines reste difficile à détecter à l’œil nu. La pollution lumineuse et la transparence du ciel sont déterminantes." }
      : { level: "challenging", label: "Trop faible pour l’œil nu", explanation: "Les planètes naines apparaissent comme de faibles points stellaires ; un instrument est nécessaire." };
    if (equipment === "binoculars") return magnitude <= 9.5
      ? { level: "medium", label: "À essayer aux jumelles dans un ciel sombre", explanation: "Une planète naine peut rester difficile à identifier aux jumelles ; compare soigneusement le champ et sa position calculée." }
      : { level: "challenging", label: "Trop faible pour des jumelles courantes", explanation: "Cette planète naine est généralement trop faible pour des jumelles courantes. Un télescope et une carte précise sont utiles." };
    if (equipment === "telescope") return magnitude <= 12.5
      ? { level: "medium", label: "Cible à chercher au télescope", explanation: "Un télescope peut suffire selon son ouverture et les conditions ; la position calculée reste simplifiée, à comparer à une éphéméride récente." }
      : { level: "challenging", label: "Cible faible au télescope", explanation: "Cette planète naine est très faible. Utilise un instrument adapté et vérifie sa position avec une éphéméride actualisée." };
    return { level: magnitude <= 9.5 ? "medium" : "challenging", label: magnitude <= 9.5 ? "À tenter avec un instrument" : "Cible faible", explanation: "Les planètes naines sont de faibles points lumineux. Les magnitudes et positions affichées sont estimatives ; elles ne remplacent pas une éphéméride de précision." };
  }

  if (type === "minor-planet") {
    if (!hasMagnitude) {
      return { level: "variable", label: "Éclat estimé indisponible", explanation: "La magnitude apparente n’est pas disponible ; la visibilité de cette planète mineure ne peut pas être estimée à partir du catalogue." };
    }
    if (equipment === "eye") {
      return magnitude <= 6.0
        ? { level: "challenging", label: "Limite de l’œil nu sous un ciel sombre", explanation: "Même parmi les astéroïdes les plus brillants, le repérage à l’œil nu est exigeant. La pollution lumineuse et la transparence du ciel sont déterminantes." }
        : { level: "challenging", label: "Trop faible pour l’œil nu", explanation: "Les planètes mineures ressemblent généralement à de faibles points stellaires. Des jumelles ou un télescope sont nécessaires pour la plupart d’entre elles." };
    }
    if (equipment === "binoculars") {
      return magnitude <= 9.5
        ? { level: "medium", label: "À essayer aux jumelles", explanation: "La magnitude suggère qu’un essai aux jumelles est possible sous un ciel sombre, mais le repérage reste délicat et nécessite une carte précise." }
        : { level: "challenging", label: "Trop faible pour des jumelles courantes", explanation: "Cette planète mineure est probablement trop faible pour des jumelles courantes. Un télescope et un champ d’étoiles de comparaison seront utiles." };
    }
    if (equipment === "telescope") {
      return magnitude <= 12.5
        ? { level: "medium", label: "Cible à chercher au télescope", explanation: "Le pointage au télescope est préférable. La magnitude est une estimation issue d’un modèle orbital simplifié ; compare la position à une éphéméride récente." }
        : { level: "challenging", label: "Cible faible au télescope", explanation: "Cette planète mineure peut nécessiter un instrument adapté, un ciel transparent et un pointage précis. Vérifie sa position avec une éphéméride actualisée." };
    }
    return { level: magnitude <= 9.5 ? "medium" : "challenging", label: magnitude <= 9.5 ? "À tenter avec un instrument" : "Cible faible", explanation: "Les planètes mineures sont de faibles points lumineux. La magnitude et les positions affichées sont estimatives ; elles ne remplacent pas une éphéméride de précision." };
  }

  if (type === "star") {
    if (!hasMagnitude) {
      return { level: "variable", label: "Difficulté indéterminée", explanation: "La magnitude apparente manque ; il n’est pas possible d’estimer sérieusement le repérage à partir du catalogue seul." };
    }

    if (equipment === "eye") {
      if (magnitude <= 2.5) return { level: "easy", label: "Très facile à repérer à l’œil nu", explanation: "L’étoile est brillante. La pollution lumineuse et la transparence du ciel peuvent néanmoins réduire le contraste près de l’horizon." };
      if (magnitude <= 4.5) return { level: "medium", label: "Repérable à l’œil nu sous un ciel favorable", explanation: "Les étoiles de cet éclat sont plus faciles à voir lorsque le ciel est sombre, transparent et que les yeux sont adaptés à l’obscurité." };
      return { level: "challenging", label: "Difficile à l’œil nu", explanation: "Cette étoile peut être trop faible en ville ou sous un ciel voilé. Des jumelles ou un ciel nettement plus sombre peuvent être nécessaires." };
    }

    if (equipment === "binoculars") {
      if (magnitude <= 5.5) return { level: "easy", label: "Facile aux jumelles", explanation: "L’étoile devrait être accessible à des jumelles courantes si le ciel est dégagé ; stabilise les jumelles pour la repérer plus confortablement." };
      if (magnitude <= 7) return { level: "medium", label: "Accessible aux jumelles sous un ciel sombre", explanation: "La détection dépend de l’ouverture des jumelles, de la stabilité et de l’obscurité du ciel." };
      return { level: "challenging", label: "Cible faible aux jumelles", explanation: "Cette étoile peut dépasser les possibilités de jumelles courantes. Un instrument plus puissant et un ciel sombre seront utiles." };
    }

    if (equipment === "telescope") {
      if (magnitude <= 8) return { level: "easy", label: "Accessible au télescope", explanation: "L’étoile devrait être accessible à de nombreux télescopes amateurs ; la mise au point, le diamètre et les conditions atmosphériques comptent." };
      if (magnitude <= 12) return { level: "medium", label: "Demande un ciel et un instrument adaptés", explanation: "La détection dépend du diamètre, du grossissement, de la transparence et de l’expérience d’observation." };
      return { level: "challenging", label: "Cible exigeante au télescope", explanation: "Cette étoile est faible. Un instrument adapté, un suivi précis et un ciel transparent peuvent être nécessaires." };
    }

    if (magnitude <= 2.5) return { level: "easy", label: "Très brillante", explanation: "Généralement visible à l’œil nu si elle est suffisamment haute et que l’horizon est dégagé." };
    if (magnitude <= 5) return { level: "medium", label: "Visibilité dépendant du ciel", explanation: "Elle peut être visible à l’œil nu sous un ciel sombre ; en ville ou sous un voile nuageux, des jumelles peuvent aider." };
    return { level: "challenging", label: "Étoile faible — instrument utile", explanation: "Elle risque d’être difficile à l’œil nu. Des jumelles ou un télescope, ainsi qu’un ciel sombre, peuvent être nécessaires." };
  }

  if (type === "cluster") {
    if (!hasMagnitude) {
      return { level: "variable", label: "Visibilité difficile à estimer", explanation: "La magnitude n’est pas disponible ; la taille apparente et la concentration des étoiles influencent aussi la visibilité de l’amas." };
    }
    if (equipment === "eye") {
      if (magnitude <= 4) return { level: "medium", label: "Peut être perceptible à l’œil nu", explanation: "L’amas peut apparaître comme une petite tache ou un motif d’étoiles. Sa magnitude totale ne garantit pas que les étoiles soient séparées ; un ciel sombre aide." };
      return { level: "challenging", label: "Difficile à l’œil nu", explanation: "La luminosité totale de l’amas est faible pour l’œil nu. Des jumelles sont généralement plus adaptées, même si la visibilité dépend de l’étendue de l’amas et du ciel." };
    }
    if (equipment === "binoculars") {
      if (magnitude <= 7.5) return { level: magnitude <= 5.5 ? "easy" : "medium", label: magnitude <= 5.5 ? "Amas accessible aux jumelles" : "Amas à essayer aux jumelles", explanation: "Les jumelles conviennent bien à de nombreux amas ouverts. Pour les amas globulaires, l’objet peut rester une tache diffuse ; un ciel sombre améliore le contraste." };
      return { level: "challenging", label: "Amas faible aux jumelles", explanation: "Un ciel sombre est important ; un télescope peut être nécessaire, notamment pour discerner des étoiles individuelles." };
    }
    if (equipment === "telescope") {
      if (magnitude <= 8.5) return { level: "easy", label: "Amas à essayer au télescope", explanation: "Le télescope peut révéler plus d’étoiles, mais le résultat dépend du diamètre, du grossissement et du type d’amas." };
      if (magnitude <= 10.5) return { level: "medium", label: "Amas exigeant au télescope", explanation: "La détection et la résolution des étoiles demandent un instrument adapté et un ciel transparent." };
      return { level: "challenging", label: "Amas faible au télescope", explanation: "La magnitude totale ne dit pas à elle seule combien d’étoiles seront perceptibles. Le diamètre et les conditions sont déterminants." };
    }
    if (magnitude <= 4) return { level: "medium", label: "Amas relativement brillant", explanation: "Il peut se présenter comme une tache ou un motif d’étoiles ; les jumelles permettent souvent d’en apprécier davantage la structure." };
    if (magnitude <= 6.5) return { level: "variable", label: "Jumelles conseillées", explanation: "Un amas peut demander des jumelles ou un télescope. L’éclat intégré ne garantit pas la séparation de ses étoiles." };
    return { level: "challenging", label: "Instrument et ciel sombre utiles", explanation: "L’amas est peu lumineux dans son ensemble ; le résultat dépend de sa concentration, du diamètre et de la transparence du ciel." };
  }

  if (["galaxy", "nebula", "deep-sky"].includes(type)) {
    const knownId = id;
    if (equipment === "eye" && ["M31", "M42"].includes(knownId)) {
      return {
        level: "challenging",
        label: knownId === "M31" ? "Faible lueur possible sous un ciel très sombre" : "Lueur diffuse possible à l’œil nu",
        explanation: knownId === "M31"
          ? "La galaxie d’Andromède peut apparaître comme une faible tache floue si le ciel est très sombre et transparent ; en zone éclairée, elle peut être invisible."
          : "La nébuleuse d’Orion peut se percevoir comme une lueur diffuse, mais pas comme les détails colorés des photographies. La transparence et la pollution lumineuse comptent beaucoup."
      };
    }
    if (equipment === "eye") {
      return {
        level: "challenging",
        label: "Généralement très difficile à l’œil nu",
        explanation: "Les galaxies et nébuleuses sont diffuses : seules quelques exceptions sont perceptibles sous un ciel très sombre. La magnitude totale ne suffit pas à prédire leur contraste sur le fond du ciel."
      };
    }
    if (equipment === "binoculars") {
      return {
        level: "variable",
        label: "Lueur diffuse possible aux jumelles",
        explanation: "Certaines cibles apparaissent comme une faible tache sous un ciel sombre. La brillance surfacique, la transparence et la pollution lumineuse comptent autant que la magnitude totale."
      };
    }
    if (equipment === "telescope") {
      return {
        level: "variable",
        label: "À essayer au télescope — détails incertains",
        explanation: "Un télescope peut révéler une tache ou une structure selon l’objet, mais les détails ne sont pas garantis. La magnitude totale ne renseigne pas assez sur la brillance surfacique ; filtres et conditions de ciel peuvent changer le résultat."
      };
    }
    return {
      level: "variable",
      label: "Visibilité très dépendante du ciel et de l’instrument",
      explanation: "Pour les objets diffus, la magnitude intégrée ne suffit pas à prévoir ce que l’œil verra. La brillance surfacique, la pollution lumineuse, la transparence, l’adaptation nocturne et l’instrument sont déterminants."
    };
  }

  return {
    level: "variable",
    label: "Visibilité à confirmer sur place",
    explanation: "Cette estimation reste indicative : l’altitude, la transparence, la pollution lumineuse et l’équipement réel influencent le résultat."
  };
}
